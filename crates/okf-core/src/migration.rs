use crate::parser::is_valid_actor;
use crate::{
    BundleDocumentInput, DocumentContent, ParseBundleInput, ParsedFrontmatter, RenderedFile,
    parse_bundle,
};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationInput {
    pub bundle: ParseBundleInput,
    pub actor: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationDocumentResult {
    pub relative_path: String,
    pub changed: bool,
    pub manual_follow_up: bool,
    pub manual_reasons: Vec<String>,
    pub actions: Vec<String>,
    pub citation_candidates: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
    pub from_version: String,
    pub to_version: &'static str,
    pub files: Vec<RenderedFile>,
    pub documents: Vec<MigrationDocumentResult>,
}

#[derive(Clone, Debug)]
struct Edit {
    start: usize,
    end: usize,
    replacement: String,
}

#[derive(Clone, Debug)]
struct CitationAnalysis {
    resources: Vec<String>,
    ambiguous: bool,
}

pub fn migrate_bundle(input: MigrationInput) -> Result<MigrationPlan, String> {
    let source = input.clone();
    let plan = migrate_bundle_with_citations(input, true)?;
    if rendered_plan_is_parseable(&source.bundle, &plan) {
        return Ok(plan);
    }
    if plan.documents.iter().any(|document| {
        document
            .actions
            .iter()
            .any(|action| action == "citations-to-sources")
    }) {
        let fallback = migrate_bundle_with_citations(source.clone(), false)?;
        if rendered_plan_is_parseable(&source.bundle, &fallback) {
            return Ok(fallback);
        }
    }
    Err("Migration rendered output is outside the canonical parser safety envelope.".to_owned())
}

fn migrate_bundle_with_citations(
    input: MigrationInput,
    allow_citation_insertions: bool,
) -> Result<MigrationPlan, String> {
    validate_actor(&input.actor)?;
    let texts = decoded_documents(&input.bundle)?;
    let bundle = parse_bundle(input.bundle);
    if let Some(failure) = bundle.failures.first() {
        return Err(format!(
            "Migration requires a completely parseable bundle; {}: {}",
            failure.bundle_path, failure.message
        ));
    }

    let root_index = bundle
        .reserved_documents
        .iter()
        .find(|document| document.source.bundle_path == "index.md")
        .ok_or_else(|| "Migration requires a bundle-root index.md.".to_owned())?;
    let from_version = root_index
        .okf_version
        .clone()
        .ok_or_else(|| "Migration requires a string okf_version declaration.".to_owned())?;
    if !matches!(from_version.as_str(), "0.1" | "0.2") {
        return Err(format!(
            "Migration supports only declared OKF 0.1 or 0.2 bundles, not {from_version:?}."
        ));
    }

    let mut files = Vec::new();
    let mut documents = Vec::new();
    let root_text = texts
        .get("index.md")
        .ok_or_else(|| "The root index source bytes are unavailable.".to_owned())?;
    let mut root_actions = Vec::new();
    if from_version == "0.1" {
        let frontmatter = root_index
            .frontmatter
            .as_ref()
            .ok_or_else(|| "The v0.1 root index has no frontmatter.".to_owned())?;
        let range =
            simple_field_range(root_text, frontmatter, "okf_version")?.ok_or_else(|| {
                "Migration requires a single-line, unanchored okf_version declaration.".to_owned()
            })?;
        let field = slice_utf16(root_text, range.start, range.end)?;
        let comment = inline_comment(field);
        let replacement = format!("okf_version: \"0.2\"{comment}");
        let root_output = apply_edits(
            root_text,
            vec![Edit {
                start: range.start,
                end: range.end,
                replacement,
            }],
        )?;
        root_actions.push("root-version-to-0.2".to_owned());
        files.push(rendered("index.md", root_output));
    }
    documents.push(MigrationDocumentResult {
        relative_path: "index.md".to_owned(),
        changed: !root_actions.is_empty(),
        manual_follow_up: false,
        manual_reasons: Vec::new(),
        actions: root_actions,
        citation_candidates: Vec::new(),
    });

    for concept in &bundle.concepts {
        let path = concept.source.bundle_path.as_str();
        let text = texts
            .get(path)
            .ok_or_else(|| format!("The source bytes for {path} are unavailable."))?;
        let line_ending = line_ending(text);
        let mut edits = Vec::new();
        let mut actions = Vec::new();
        let mut manual_follow_up = false;
        let mut manual_reasons = Vec::new();
        let mut citation_candidates = Vec::new();

        if concept.frontmatter.raw.contains_key("timestamp")
            && !concept.frontmatter.raw.contains_key("generated")
        {
            if let Some(timestamp) = concept
                .timestamp
                .as_deref()
                .filter(|value| is_rfc3339(value))
            {
                if let Some(range) = simple_field_range(text, &concept.frontmatter, "timestamp")? {
                    let field = slice_utf16(text, range.start, range.end)?;
                    let comment = inline_comment(field);
                    edits.push(Edit {
                        start: range.start,
                        end: range.end,
                        replacement: format!(
                            "generated:{line_ending}  by: {}{line_ending}  at: {}{comment}",
                            yaml_quote(&input.actor),
                            yaml_quote(timestamp),
                        ),
                    });
                    actions.push("timestamp-to-generated".to_owned());
                } else {
                    manual_follow_up = true;
                    manual_reasons.push("timestamp-requires-manual-migration".to_owned());
                }
            } else {
                manual_follow_up = true;
                manual_reasons.push("timestamp-requires-manual-migration".to_owned());
            }
        }

        if let Some(analysis) = analyze_citations(&concept.body) {
            citation_candidates.clone_from(&analysis.resources);
            if analysis.ambiguous || analysis.resources.is_empty() {
                manual_follow_up = true;
                manual_reasons.push("citations-require-manual-review".to_owned());
            } else if !concept.frontmatter.raw.contains_key("sources") && allow_citation_insertions
            {
                let closing = frontmatter_closing_start(text)?;
                let mut block = format!("sources:{line_ending}");
                for resource in &analysis.resources {
                    block.push_str(&format!(
                        "  - resource: {}{line_ending}",
                        yaml_quote(resource)
                    ));
                }
                let citation_edit = Edit {
                    start: utf16_len(&text[..closing]),
                    end: utf16_len(&text[..closing]),
                    replacement: block,
                };
                let mut proposed_edits = edits.clone();
                proposed_edits.push(citation_edit.clone());
                let proposal = apply_edits(text, proposed_edits)?;
                if rendered_concept_is_parseable(path, &concept.source.uri, &proposal) {
                    edits.push(citation_edit);
                    actions.push("citations-to-sources".to_owned());
                } else {
                    manual_follow_up = true;
                    manual_reasons.push("citations-require-manual-review".to_owned());
                }
            } else if !concept.frontmatter.raw.contains_key("sources") {
                manual_follow_up = true;
                manual_reasons.push("citations-require-manual-review".to_owned());
            }
        }

        let changed = !edits.is_empty();
        if changed {
            files.push(rendered(path, apply_edits(text, edits)?));
        }
        documents.push(MigrationDocumentResult {
            relative_path: path.to_owned(),
            changed,
            manual_follow_up,
            manual_reasons,
            actions,
            citation_candidates,
        });
    }

    files.sort_by(|left, right| {
        (left.relative_path == "index.md")
            .cmp(&(right.relative_path == "index.md"))
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    documents.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(MigrationPlan {
        from_version,
        to_version: "0.2",
        files,
        documents,
    })
}

fn decoded_documents(input: &ParseBundleInput) -> Result<BTreeMap<String, String>, String> {
    let mut texts = BTreeMap::new();
    for document in &input.documents {
        if document.identity_only_failure.is_some() {
            return Err(format!(
                "Migration cannot read {} completely.",
                document.bundle_path
            ));
        }
        let text = match document.content.as_ref() {
            Some(DocumentContent::Text(value)) => value.clone(),
            Some(DocumentContent::Bytes(bytes)) => {
                String::from_utf8(bytes.clone()).map_err(|_| {
                    format!(
                        "Migration requires valid UTF-8 in {}.",
                        document.bundle_path
                    )
                })?
            }
            Some(DocumentContent::InvalidUtf16 { .. }) => {
                return Err(format!(
                    "Migration requires valid UTF-16 text in {}.",
                    document.bundle_path
                ));
            }
            None => {
                return Err(format!(
                    "Migration cannot read {} completely.",
                    document.bundle_path
                ));
            }
        };
        if texts.insert(document.bundle_path.clone(), text).is_some() {
            return Err(format!(
                "Migration found duplicate document path {}.",
                document.bundle_path
            ));
        }
    }
    Ok(texts)
}

fn validate_actor(actor: &str) -> Result<(), String> {
    if !is_valid_actor(actor) {
        return Err(
            "Migration actor must use human:<id>, process:<id>, or <producer>/<version>."
                .to_owned(),
        );
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
struct FieldRange {
    start: usize,
    end: usize,
}

fn simple_field_range(
    text: &str,
    frontmatter: &ParsedFrontmatter,
    field: &str,
) -> Result<Option<FieldRange>, String> {
    let source_offset = usize::from(text.starts_with('\u{feff}'));
    let source = frontmatter.source.as_str();
    let mut byte_start = 0usize;
    while byte_start <= source.len() {
        let content_end = source.as_bytes()[byte_start..]
            .iter()
            .position(|byte| matches!(byte, b'\r' | b'\n'))
            .map_or(source.len(), |relative| byte_start + relative);
        let line = &source[byte_start..content_end];
        if let Some(value_start) = top_level_field_value_start(line, field) {
            let value = line[value_start..].trim_start();
            if !is_single_line_unanchored_scalar(value) {
                return Ok(None);
            }
            let canonical_start = frontmatter.range.start.offset + utf16_len(&source[..byte_start]);
            let canonical_end = frontmatter.range.start.offset + utf16_len(&source[..content_end]);
            if has_following_indented_value_line(source, content_end) {
                return Ok(None);
            }
            let Some(field_range) = frontmatter
                .fields
                .get(field)
                .cloned()
                .and_then(|value| serde_json::from_value::<crate::SourceRange>(value).ok())
            else {
                return Ok(None);
            };
            if field_range.end.offset > canonical_end {
                return Ok(None);
            }
            let start = canonical_start + source_offset;
            let end = canonical_end + source_offset;
            if slice_utf16(text, start, end)? != line {
                return Err(format!(
                    "The {field} source range does not match the document."
                ));
            }
            return Ok(Some(FieldRange { start, end }));
        }
        if content_end == source.len() {
            break;
        }
        byte_start = content_end
            + usize::from(
                source.as_bytes()[content_end] == b'\r'
                    && source.as_bytes().get(content_end + 1).copied() == Some(b'\n'),
            )
            + 1;
    }
    Err(format!("The {field} source range is unavailable."))
}

fn has_following_indented_value_line(source: &str, mut offset: usize) -> bool {
    while offset < source.len() {
        if source.as_bytes()[offset] == b'\r' {
            offset += 1;
            if source.as_bytes().get(offset) == Some(&b'\n') {
                offset += 1;
            }
        } else if source.as_bytes()[offset] == b'\n' {
            offset += 1;
        }
        let line_end = source.as_bytes()[offset..]
            .iter()
            .position(|byte| matches!(byte, b'\r' | b'\n'))
            .map_or(source.len(), |relative| offset + relative);
        let line = &source[offset..line_end];
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            offset = line_end;
            continue;
        }
        return line.starts_with(char::is_whitespace);
    }
    false
}

fn is_single_line_unanchored_scalar(mut value: &str) -> bool {
    loop {
        if value.starts_with('&') {
            return false;
        }
        if let Some(verbatim) = value.strip_prefix("!<") {
            let Some(end) = verbatim.find('>') else {
                return false;
            };
            value = verbatim[end + 1..].trim_start();
            continue;
        }
        let Some(tag) = value.strip_prefix('!') else {
            break;
        };
        let end = tag.find(char::is_whitespace).unwrap_or(tag.len());
        value = tag[end..].trim_start();
    }
    !value.is_empty() && !value.starts_with(['|', '>', '&', '*'])
}

fn top_level_field_value_start(line: &str, field: &str) -> Option<usize> {
    if line.starts_with(char::is_whitespace) {
        return None;
    }
    for prefix in [
        field.to_owned(),
        format!("'{field}'"),
        format!("\"{field}\""),
    ] {
        let Some(remainder) = line.strip_prefix(&prefix) else {
            continue;
        };
        let whitespace = remainder.len() - remainder.trim_start_matches([' ', '\t']).len();
        if remainder.as_bytes().get(whitespace).copied() == Some(b':') {
            return Some(prefix.len() + whitespace + 1);
        }
    }
    None
}

fn apply_edits(text: &str, mut edits: Vec<Edit>) -> Result<String, String> {
    edits.sort_by(|left, right| {
        right
            .start
            .cmp(&left.start)
            .then_with(|| right.end.cmp(&left.end))
    });
    let mut output = text.to_owned();
    let mut prior_start = usize::MAX;
    for edit in edits {
        if edit.end > prior_start || edit.start > edit.end {
            return Err("Migration produced overlapping source edits.".to_owned());
        }
        let start = byte_offset_for_utf16(&output, edit.start)?;
        let end = byte_offset_for_utf16(&output, edit.end)?;
        output.replace_range(start..end, &edit.replacement);
        prior_start = edit.start;
    }
    Ok(output)
}

fn slice_utf16(text: &str, start: usize, end: usize) -> Result<&str, String> {
    let start = byte_offset_for_utf16(text, start)?;
    let end = byte_offset_for_utf16(text, end)?;
    text.get(start..end)
        .ok_or_else(|| "Migration source range is not a valid text boundary.".to_owned())
}

fn byte_offset_for_utf16(text: &str, target: usize) -> Result<usize, String> {
    if target == 0 {
        return Ok(0);
    }
    let mut units = 0usize;
    for (index, character) in text.char_indices() {
        if units == target {
            return Ok(index);
        }
        units += character.len_utf16();
        if units > target {
            return Err("Migration source offset splits a Unicode scalar.".to_owned());
        }
    }
    if units == target {
        Ok(text.len())
    } else {
        Err("Migration source offset exceeds the document.".to_owned())
    }
}

fn frontmatter_closing_start(text: &str) -> Result<usize, String> {
    let mut offset = 0usize;
    let mut opening_seen = false;
    while offset <= text.len() {
        let end = text.as_bytes()[offset..]
            .iter()
            .position(|byte| matches!(byte, b'\r' | b'\n'))
            .map_or(text.len(), |relative| offset + relative);
        let content = &text[offset..end];
        if !opening_seen {
            if content.trim_start_matches('\u{feff}') == "---" {
                opening_seen = true;
            }
        } else if content == "---" {
            return Ok(offset);
        }
        if end == text.len() {
            break;
        }
        offset =
            end + usize::from(
                text.as_bytes()[end] == b'\r'
                    && text.as_bytes().get(end + 1).copied() == Some(b'\n'),
            ) + 1;
    }
    Err("Migration could not locate the frontmatter closing delimiter.".to_owned())
}

fn analyze_citations(body: &str) -> Option<CitationAnalysis> {
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    let mut in_citations = false;
    let mut found = false;
    let mut ambiguous = false;
    let mut resources = Vec::new();
    let mut seen = BTreeSet::new();
    let mut fence: Option<(char, usize)> = None;
    let mut html_block: Option<HtmlBlock> = None;
    for raw_line in normalized.lines() {
        let (indent, line) = markdown_indent(raw_line);
        if let Some((marker, length)) = fence {
            if indent <= 3
                && fence_run(line, marker).is_some_and(|run| {
                    run >= length && line[run..].chars().all(char::is_whitespace)
                })
            {
                fence = None;
            }
            continue;
        }
        if let Some(kind) = html_block {
            if line.contains("Citations") {
                found = true;
                ambiguous = true;
            }
            if kind.ends(line) {
                html_block = None;
            }
            continue;
        }
        if indent <= 3
            && let Some((marker, length)) = fence_opening(line)
        {
            if in_citations {
                ambiguous = true;
            }
            fence = Some((marker, length));
            continue;
        }
        if indent <= 3
            && let Some(kind) = html_block_opening(line)
        {
            if in_citations || line.contains("Citations") {
                found = true;
                ambiguous = true;
            }
            if !kind.ends(line) {
                html_block = Some(kind);
            }
            continue;
        }
        if indent <= 3
            && let Some(rest) = line.strip_prefix('#')
            && rest
                .chars()
                .next()
                .is_none_or(|character| character == ' ' || character == '\t')
        {
            let title = atx_heading_title(rest);
            in_citations = title == "Citations";
            if in_citations {
                found = true;
            }
            continue;
        }
        if !in_citations || line.trim().is_empty() {
            continue;
        }
        if indent > 3 {
            continue;
        }
        let trimmed = line.trim();
        let candidate = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "));
        if let Some(resource) = candidate
            && is_simple_url(resource)
        {
            if seen.insert(resource.to_owned()) {
                resources.push(resource.to_owned());
            }
        } else {
            ambiguous = true;
        }
    }
    found.then_some(CitationAnalysis {
        resources,
        ambiguous,
    })
}

fn markdown_indent(line: &str) -> (usize, &str) {
    let mut columns = 0usize;
    let mut offset = 0usize;
    for (index, character) in line.char_indices() {
        match character {
            ' ' => columns += 1,
            '\t' => columns += 4 - columns % 4,
            _ => {
                offset = index;
                return (columns, &line[offset..]);
            }
        }
        offset = index + character.len_utf8();
    }
    (columns, &line[offset..])
}

fn atx_heading_title(rest: &str) -> &str {
    let title = rest.trim();
    let without_hashes = title.trim_end_matches('#');
    if without_hashes.len() < title.len()
        && without_hashes
            .chars()
            .next_back()
            .is_some_and(char::is_whitespace)
    {
        without_hashes.trim_end()
    } else {
        title
    }
}

fn fence_opening(line: &str) -> Option<(char, usize)> {
    for marker in ['`', '~'] {
        let Some(length) = fence_run(line, marker) else {
            continue;
        };
        if length >= 3 && (marker != '`' || !line[length..].contains('`')) {
            return Some((marker, length));
        }
    }
    None
}

fn fence_run(line: &str, marker: char) -> Option<usize> {
    let length = line
        .chars()
        .take_while(|character| *character == marker)
        .count();
    (length > 0).then_some(length)
}

fn is_simple_url(value: &str) -> bool {
    (value.starts_with("https://") || value.starts_with("http://"))
        && !value.chars().any(|character| {
            character.is_whitespace() || character.is_control() || character == '\u{feff}'
        })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HtmlBlock {
    Comment,
    ProcessingInstruction,
    Declaration,
    Cdata,
    Script,
    Pre,
    Style,
    Textarea,
    UntilBlank,
}

impl HtmlBlock {
    fn ends(self, line: &str) -> bool {
        match self {
            Self::Comment => line.contains("-->"),
            Self::ProcessingInstruction => line.contains("?>"),
            Self::Declaration => line.contains('>'),
            Self::Cdata => line.contains("]]>"),
            Self::Script => line.to_ascii_lowercase().contains("</script>"),
            Self::Pre => line.to_ascii_lowercase().contains("</pre>"),
            Self::Style => line.to_ascii_lowercase().contains("</style>"),
            Self::Textarea => line.to_ascii_lowercase().contains("</textarea>"),
            Self::UntilBlank => line.trim().is_empty(),
        }
    }
}

fn html_block_opening(line: &str) -> Option<HtmlBlock> {
    let lower = line.to_ascii_lowercase();
    if line.starts_with("<!--") {
        Some(HtmlBlock::Comment)
    } else if line.starts_with("<?") {
        Some(HtmlBlock::ProcessingInstruction)
    } else if line.starts_with("<![CDATA[") {
        Some(HtmlBlock::Cdata)
    } else if line
        .strip_prefix("<!")
        .and_then(|rest| rest.chars().next())
        .is_some_and(|character| character.is_ascii_uppercase())
    {
        Some(HtmlBlock::Declaration)
    } else if html_tag_starts(&lower, "script") {
        Some(HtmlBlock::Script)
    } else if html_tag_starts(&lower, "pre") {
        Some(HtmlBlock::Pre)
    } else if html_tag_starts(&lower, "style") {
        Some(HtmlBlock::Style)
    } else if html_tag_starts(&lower, "textarea") {
        Some(HtmlBlock::Textarea)
    } else if [
        "address",
        "article",
        "aside",
        "base",
        "basefont",
        "blockquote",
        "body",
        "caption",
        "center",
        "col",
        "colgroup",
        "dd",
        "details",
        "dialog",
        "dir",
        "div",
        "dl",
        "dt",
        "fieldset",
        "figcaption",
        "figure",
        "footer",
        "form",
        "frame",
        "frameset",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "head",
        "header",
        "hr",
        "html",
        "iframe",
        "legend",
        "li",
        "link",
        "main",
        "menu",
        "menuitem",
        "nav",
        "noframes",
        "ol",
        "optgroup",
        "option",
        "p",
        "section",
        "source",
        "summary",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "title",
        "tr",
        "track",
        "ul",
    ]
    .iter()
    .any(|tag| html_tag_starts(&lower, tag))
        || complete_html_tag_line(line)
    {
        Some(HtmlBlock::UntilBlank)
    } else {
        None
    }
}

fn html_tag_starts(line: &str, tag: &str) -> bool {
    line.strip_prefix("</")
        .or_else(|| line.strip_prefix('<'))
        .and_then(|rest| rest.strip_prefix(tag))
        .and_then(|rest| rest.chars().next())
        .is_some_and(|character| character.is_whitespace() || matches!(character, '/' | '>'))
}

fn complete_html_tag_line(line: &str) -> bool {
    let trimmed = line.trim_end();
    trimmed.len() > 2
        && trimmed.starts_with('<')
        && trimmed.ends_with('>')
        && !trimmed.starts_with("<http://")
        && !trimmed.starts_with("<https://")
        && !trimmed[1..trimmed.len() - 1].contains(['<', '>'])
}

fn rendered_concept_is_parseable(path: &str, uri: &str, content: &str) -> bool {
    parse_bundle(ParseBundleInput {
        root_uri: "fixture:/migration-proposal".to_owned(),
        invalid_root_uri_utf16: None,
        revision: 1,
        documents: vec![BundleDocumentInput {
            uri: uri.to_owned(),
            bundle_path: path.to_owned(),
            content: Some(DocumentContent::Text(content.to_owned())),
            content_hash: None,
            identity_only_failure: None,
            invalid_utf16_fields: None,
        }],
    })
    .failures
    .is_empty()
}

fn rendered_plan_is_parseable(input: &ParseBundleInput, plan: &MigrationPlan) -> bool {
    let outputs = plan
        .files
        .iter()
        .map(|file| (file.relative_path.as_str(), file.content.as_str()))
        .collect::<BTreeMap<_, _>>();
    let mut proposal = input.clone();
    for document in &mut proposal.documents {
        if let Some(content) = outputs.get(document.bundle_path.as_str()) {
            document.content = Some(DocumentContent::Text((*content).to_owned()));
            document.content_hash = None;
        }
    }
    parse_bundle(proposal).failures.is_empty()
}

fn is_rfc3339(value: &str) -> bool {
    value
        .as_bytes()
        .get(10)
        .is_some_and(|separator| matches!(separator, b'T' | b't'))
        && DateTime::parse_from_rfc3339(value).is_ok()
}

fn inline_comment(field: &str) -> &str {
    field
        .char_indices()
        .find_map(|(index, character)| {
            let whitespace_start = field[..index]
                .char_indices()
                .next_back()
                .filter(|(_, previous)| previous.is_whitespace())
                .map(|(previous_index, _)| previous_index);
            (character == '#').then(|| whitespace_start.map(|start| &field[start..]))?
        })
        .unwrap_or("")
}

fn line_ending(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else if text.contains('\n') {
        "\n"
    } else if text.contains('\r') {
        "\r"
    } else {
        "\n"
    }
}

fn yaml_quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn rendered(path: &str, content: String) -> RenderedFile {
    RenderedFile {
        relative_path: path.to_owned(),
        encoding: "utf8",
        content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BundleDocumentInput;

    fn migration_result(documents: &[(&str, &str)]) -> Result<MigrationPlan, String> {
        migrate_bundle(MigrationInput {
            bundle: ParseBundleInput {
                root_uri: "fixture:/migration".to_owned(),
                invalid_root_uri_utf16: None,
                revision: 1,
                documents: documents
                    .iter()
                    .map(|(path, content)| BundleDocumentInput {
                        uri: format!("fixture:/migration/{path}"),
                        bundle_path: (*path).to_owned(),
                        content: Some(DocumentContent::Text((*content).to_owned())),
                        content_hash: None,
                        identity_only_failure: None,
                        invalid_utf16_fields: None,
                    })
                    .collect(),
            },
            actor: "human:reviewer".to_owned(),
        })
    }

    fn migration(documents: &[(&str, &str)]) -> MigrationPlan {
        migration_result(documents).unwrap()
    }

    #[test]
    fn migrates_version_timestamp_and_simple_citations_without_removing_body() {
        let root = "---\nokf_version: \"0.1\"\n---\n# Root\n";
        let concept = concat!(
            "---\n",
            "type: Reference\n",
            "title: Provenance\n",
            "description: Legacy provenance\n",
            "timestamp: \"2026-07-22T10:00:00Z\"\n",
            "custom_field: retained\n",
            "---\n",
            "# Provenance\n\n",
            "# Citations\n\n",
            "- https://example.com/one\n",
            "* https://example.com/two\n",
        );
        let plan = migration(&[("index.md", root), ("provenance.md", concept)]);

        assert_eq!(plan.from_version, "0.1");
        assert_eq!(plan.files.len(), 2);
        let root_output = &plan
            .files
            .iter()
            .find(|file| file.relative_path == "index.md")
            .unwrap()
            .content;
        assert!(root_output.contains("okf_version: \"0.2\""));
        let output = &plan
            .files
            .iter()
            .find(|file| file.relative_path == "provenance.md")
            .unwrap()
            .content;
        assert!(output.contains("generated:\n  by: \"human:reviewer\""));
        assert!(output.contains("custom_field: retained"));
        assert!(output.contains("  - resource: \"https://example.com/one\""));
        assert!(output.contains("# Citations\n\n- https://example.com/one"));
        assert!(
            !plan
                .documents
                .iter()
                .any(|document| document.manual_follow_up)
        );

        let second = migration(&[("index.md", root_output), ("provenance.md", output)]);
        assert!(second.files.is_empty());
    }

    #[test]
    fn retains_ambiguous_citations_for_manual_follow_up() {
        let plan = migration(&[
            ("index.md", "---\nokf_version: \"0.1\"\n---\n# Root\n"),
            (
                "notes.md",
                concat!(
                    "---\n",
                    "type: Reference\n",
                    "title: Notes\n",
                    "description: Notes\n",
                    "---\n",
                    "# Notes\n\n",
                    "# Citations\n\n",
                    "- [Named source](https://example.com/source)\n",
                ),
            ),
            (
                "control.md",
                "---\ntype: Reference\n---\n# Citations\n\n- https://example.com/\u{1}\n",
            ),
        ]);
        for path in ["notes.md", "control.md"] {
            let document = plan
                .documents
                .iter()
                .find(|document| document.relative_path == path)
                .unwrap();
            assert!(document.manual_follow_up);
            assert!(!document.changed);
        }
        assert!(
            plan.files
                .iter()
                .all(|file| !matches!(file.relative_path.as_str(), "notes.md" | "control.md"))
        );
    }

    #[test]
    fn ignores_citation_headings_inside_code_fences_and_supports_cr_only_files() {
        let fenced = concat!(
            "---\n",
            "type: Reference\n",
            "title: Example\n",
            "description: Code sample\n",
            "---\n",
            "# Example\n\n",
            "```md\n",
            "# Citations\n",
            "- https://example.com/not-a-source\n",
            "```\n",
        );
        let cr_only = "---\rtype: Reference\rtitle: CR\rdescription: CR-only\rtimestamp: \"2026-07-22t10:00:00z\"\r---\r# CR\r\r# Citations\r\r- https://example.com/source\r";
        let plan = migration(&[
            ("index.md", "---\rokf_version: \"0.1\"\r---\r# Root\r"),
            ("B.md", fenced),
            ("a.md", cr_only),
        ]);
        assert!(
            plan.files
                .iter()
                .all(|file| !file.content.contains("not-a-source"))
        );
        let cr_output = &plan
            .files
            .iter()
            .find(|file| file.relative_path == "a.md")
            .unwrap()
            .content;
        assert!(cr_output.contains("generated:\r  by: \"human:reviewer\""));
        assert!(cr_output.contains("sources:\r  - resource: \"https://example.com/source\""));
        assert_eq!(
            plan.files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.md", "index.md"]
        );
    }

    #[test]
    fn quoted_keys_migrate_while_anchors_and_multiline_values_fail_closed() {
        let quoted = migration(&[
            ("index.md", "---\n\"okf_version\": \"0.1\"\n---\n# Root\n"),
            (
                "quoted.md",
                "---\ntype: Reference\n'timestamp': \"2026-07-22T10:00:00Z\"\n---\n# Quoted\n",
            ),
        ]);
        assert_eq!(
            quoted
                .files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["quoted.md", "index.md"]
        );
        assert!(quoted.files.iter().all(|file| {
            parse_bundle(ParseBundleInput {
                root_uri: "fixture:/reparse".to_owned(),
                invalid_root_uri_utf16: None,
                revision: 1,
                documents: vec![BundleDocumentInput {
                    uri: format!("fixture:/reparse/{}", file.relative_path),
                    bundle_path: file.relative_path.clone(),
                    content: Some(DocumentContent::Text(file.content.clone())),
                    content_hash: None,
                    identity_only_failure: None,
                    invalid_utf16_fields: None,
                }],
            })
            .failures
            .is_empty()
        }));

        let anchored_root = migration_result(&[(
            "index.md",
            "---\nokf_version: &version \"0.1\"\nproducer_version: *version\n---\n# Root\n",
        )]);
        assert!(anchored_root.is_err());
        let tagged_anchored_root = migration_result(&[(
            "index.md",
            "---\nokf_version: !<tag:yaml.org,2002:str> &version \"0.1\"\nproducer_version: *version\n---\n# Root\n",
        )]);
        assert!(tagged_anchored_root.is_err());
        for source in [
            "---\nokf_version: !!str\n  0.1\n---\n# Root\n",
            "---\nokf_version: !<tag:yaml.org,2002:str> >-\n  0.1\n---\n# Root\n",
            "---\nokf_version: !!str # retained\n  0.1\n---\n# Root\n",
            "---\nokf_version: \"0.\\\n  1\"\n---\n# Root\n",
        ] {
            assert!(migration_result(&[("index.md", source)]).is_err());
        }

        let manual = migration(&[
            ("index.md", "---\nokf_version: \"0.1\"\n---\n# Root\n"),
            (
                "anchored.md",
                "---\ntype: Reference\ntimestamp: &when \"2026-07-22T10:00:00Z\"\nproducer_time: *when\n---\n# Anchored\n",
            ),
            (
                "multiline.md",
                "---\ntype: Reference\ntimestamp: >-\n  2026-07-22T10:00:00Z\n---\n# Multiline\n",
            ),
            (
                "tagged-anchored.md",
                "---\ntype: Reference\ntimestamp: !<tag:yaml.org,2002:str> &when \"2026-07-22T10:00:00Z\"\nproducer_time: *when\n---\n# Tagged anchored\n",
            ),
            (
                "tag-only-line.md",
                "---\ntype: Reference\ntimestamp: !!str\n  2026-07-22T10:00:00Z\n---\n# Tag only line\n",
            ),
            (
                "tagged-block.md",
                "---\ntype: Reference\ntimestamp: !<tag:yaml.org,2002:str> >-\n  2026-07-22T10:00:00Z\n---\n# Tagged block\n",
            ),
            (
                "comment-continuation.md",
                "---\ntype: Reference\ntimestamp: !!str # retained\n  2026-07-22T10:00:00Z\n---\n# Comment continuation\n",
            ),
            (
                "quoted-continuation.md",
                "---\ntype: Reference\ntimestamp: \"2026-07-22T10:00:\\\n  00Z\"\n---\n# Quoted continuation\n",
            ),
        ]);
        assert_eq!(manual.files.len(), 1);
        assert!(
            manual
                .documents
                .iter()
                .filter(|document| document.relative_path != "index.md")
                .all(|document| {
                    document.manual_follow_up
                        && !document.changed
                        && document
                            .manual_reasons
                            .contains(&"timestamp-requires-manual-migration".to_owned())
                })
        );
    }

    #[test]
    fn ignores_indented_code_and_requires_a_commonmark_atx_citations_heading() {
        let plan = migration(&[
            ("index.md", "---\nokf_version: \"0.1\"\n---\n# Root\n"),
            (
                "indented.md",
                "---\ntype: Reference\n---\n# Citations\n\n    - https://example.com/code\n",
            ),
            (
                "not-heading.md",
                "---\ntype: Reference\n---\n# Citations#\n\n- https://example.com/not-a-citation\n",
            ),
            (
                "tabbed.md",
                "---\ntype: Reference\n---\n# Citations\n\n\t- https://example.com/tab-code\n",
            ),
            (
                "three-space-tab.md",
                "---\ntype: Reference\n---\n# Citations\n\n   \t- https://example.com/tab-code\n",
            ),
            (
                "indented-fence-close.md",
                "---\ntype: Reference\n---\n```md\n    ```\n# Citations\n- https://example.com/not-a-source\n```\n",
            ),
        ]);
        assert_eq!(plan.files.len(), 1);
        let indented = plan
            .documents
            .iter()
            .find(|document| document.relative_path == "indented.md")
            .unwrap();
        assert!(indented.manual_follow_up);
        assert!(indented.citation_candidates.is_empty());
        for path in ["tabbed.md", "three-space-tab.md"] {
            let document = plan
                .documents
                .iter()
                .find(|document| document.relative_path == path)
                .unwrap();
            assert!(document.manual_follow_up);
            assert!(document.citation_candidates.is_empty());
        }
        let not_heading = plan
            .documents
            .iter()
            .find(|document| document.relative_path == "not-heading.md")
            .unwrap();
        assert!(!not_heading.manual_follow_up);
        assert!(not_heading.citation_candidates.is_empty());
        let fenced = plan
            .documents
            .iter()
            .find(|document| document.relative_path == "indented-fence-close.md")
            .unwrap();
        assert!(!fenced.manual_follow_up);
        assert!(fenced.citation_candidates.is_empty());
    }

    #[test]
    fn leading_bom_offsets_work_for_text_bytes_and_all_line_endings() {
        for line_ending in ["\n", "\r\n", "\r"] {
            let root = format!(
                "\u{feff}---{line_ending}okf_version: \"0.1\"{line_ending}---{line_ending}# Root{line_ending}"
            );
            let concept = format!(
                "\u{feff}---{line_ending}type: Reference{line_ending}timestamp: \"2026-07-22T10:00:00Z\"{line_ending}---{line_ending}# Citations{line_ending}{line_ending}- https://example.com/source{line_ending}"
            );
            for bytes in [false, true] {
                let content = |value: &str| {
                    if bytes {
                        DocumentContent::Bytes(value.as_bytes().to_vec())
                    } else {
                        DocumentContent::Text(value.to_owned())
                    }
                };
                let plan = migrate_bundle(MigrationInput {
                    bundle: ParseBundleInput {
                        root_uri: "fixture:/migration-bom".to_owned(),
                        invalid_root_uri_utf16: None,
                        revision: 1,
                        documents: vec![
                            BundleDocumentInput {
                                uri: "fixture:/migration-bom/index.md".to_owned(),
                                bundle_path: "index.md".to_owned(),
                                content: Some(content(&root)),
                                content_hash: None,
                                identity_only_failure: None,
                                invalid_utf16_fields: None,
                            },
                            BundleDocumentInput {
                                uri: "fixture:/migration-bom/concept.md".to_owned(),
                                bundle_path: "concept.md".to_owned(),
                                content: Some(content(&concept)),
                                content_hash: None,
                                identity_only_failure: None,
                                invalid_utf16_fields: None,
                            },
                        ],
                    },
                    actor: "human:reviewer".to_owned(),
                })
                .unwrap();
                let root_output = &plan
                    .files
                    .iter()
                    .find(|file| file.relative_path == "index.md")
                    .unwrap()
                    .content;
                assert_eq!(
                    root_output,
                    &format!(
                        "\u{feff}---{line_ending}okf_version: \"0.2\"{line_ending}---{line_ending}# Root{line_ending}"
                    )
                );
                let concept_output = &plan
                    .files
                    .iter()
                    .find(|file| file.relative_path == "concept.md")
                    .unwrap()
                    .content;
                assert!(concept_output.starts_with("\u{feff}---"));
                assert!(
                    concept_output
                        .contains(&format!("generated:{line_ending}  by: \"human:reviewer\""))
                );
                assert!(concept_output.contains(&format!(
                    "sources:{line_ending}  - resource: \"https://example.com/source\"{line_ending}---"
                )));
            }
        }
    }

    #[test]
    fn scans_all_citation_sections_and_marks_html_pseudo_sections_manual() {
        let plan = migration(&[
            ("index.md", "---\nokf_version: \"0.1\"\n---\n# Root\n"),
            (
                "multiple.md",
                "---\ntype: Reference\n---\n# Citations\n- https://example.com/one\n# Notes\ntext\n# Citations\n- https://example.com/two\n",
            ),
            (
                "html.md",
                "---\ntype: Reference\n---\n<!--\n# Citations\n- https://example.com/not-a-source\n-->\n",
            ),
            (
                "script.md",
                "---\ntype: Reference\n---\n<script>\n\n# Citations\n- https://example.com/not-a-source\n</script>\n",
            ),
        ]);
        let multiple = plan
            .documents
            .iter()
            .find(|document| document.relative_path == "multiple.md")
            .unwrap();
        assert!(multiple.changed);
        assert!(!multiple.manual_follow_up);
        assert_eq!(
            multiple.citation_candidates,
            ["https://example.com/one", "https://example.com/two"]
        );
        let html = plan
            .documents
            .iter()
            .find(|document| document.relative_path == "html.md")
            .unwrap();
        assert!(!html.changed);
        assert!(html.manual_follow_up);
        assert!(html.citation_candidates.is_empty());
        let script = plan
            .documents
            .iter()
            .find(|document| document.relative_path == "script.md")
            .unwrap();
        assert!(!script.changed);
        assert!(script.manual_follow_up);
        assert!(script.citation_candidates.is_empty());
    }

    #[test]
    fn analyzes_existing_sources_and_rejects_bom_inside_urls() {
        let plan = migration(&[
            ("index.md", "---\nokf_version: \"0.2\"\n---\n# Root\n"),
            (
                "existing.md",
                "---\ntype: Reference\nsources:\n  - resource: \"https://example.com/existing\"\n---\n# Citations\n- [Named](https://example.com/named)\n",
            ),
            (
                "bom-url.md",
                "---\ntype: Reference\n---\n# Citations\n- https://example.com/a\u{feff}b\n",
            ),
        ]);
        for path in ["existing.md", "bom-url.md"] {
            let document = plan
                .documents
                .iter()
                .find(|document| document.relative_path == path)
                .unwrap();
            assert!(!document.changed);
            assert!(document.manual_follow_up);
            assert_eq!(document.manual_reasons, ["citations-require-manual-review"]);
        }
    }

    #[test]
    fn refuses_citation_insertion_that_exceeds_parser_limits() {
        let long_url = format!("https://example.com/{}", "a".repeat(65_500));
        let concept =
            format!("---\ntype: Reference\n---\n# Citations\n- {long_url}\n- {long_url}\n");
        let plan = migration(&[
            ("index.md", "---\nokf_version: \"0.1\"\n---\n# Root\n"),
            ("long.md", &concept),
        ]);
        let document = plan
            .documents
            .iter()
            .find(|document| document.relative_path == "long.md")
            .unwrap();
        assert!(!document.changed);
        assert!(document.manual_follow_up);
        assert_eq!(document.citation_candidates, [long_url]);
        assert_eq!(
            plan.files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["index.md"]
        );
    }
}
