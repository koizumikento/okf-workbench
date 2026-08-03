use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error, ser::SerializeMap};
use serde_json::{Map, Value, value::RawValue};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePosition {
    pub offset: usize,
    pub line: usize,
    pub character: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub start: SourcePosition,
    pub end: SourcePosition,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDocument {
    pub uri: String,
    pub bundle_path: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_window: Option<UsageWindow>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputationParameter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputationEndpoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    #[serde(default)]
    pub receipt: Vec<String>,
}

fn default_trust_tier() -> String {
    "unverified".to_owned()
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedFrontmatter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated: Option<GeneratedMetadata>,
    #[serde(default)]
    pub verified: Vec<VerificationEvent>,
    #[serde(default = "default_trust_tier")]
    pub trust_tier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_after: Option<String>,
    #[serde(default)]
    pub sources: Vec<KnowledgeSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_window: Option<UsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default)]
    pub parameters: Vec<ComputationParameter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<ComputationEndpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attester: Option<ComputationEndpoint>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFrontmatter {
    pub raw: Map<String, Value>,
    pub explicit_tags: Map<String, Value>,
    pub source: String,
    pub range: SourceRange,
    pub fields: Map<String, Value>,
    pub normalized: NormalizedFrontmatter,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LinkClassification {
    Internal,
    Broken,
    External,
    OutOfBundle,
    Fragment,
    Directory,
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConceptLink {
    pub source_id: String,
    pub raw_target: String,
    pub label: String,
    pub classification: LinkClassification,
    pub range: SourceRange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Concept {
    pub kind: String,
    pub id: String,
    pub source: SourceDocument,
    pub frontmatter: ParsedFrontmatter,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated: Option<GeneratedMetadata>,
    #[serde(default)]
    pub verified: Vec<VerificationEvent>,
    #[serde(default = "default_trust_tier")]
    pub trust_tier: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_after: Option<String>,
    #[serde(default)]
    pub sources: Vec<KnowledgeSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_window: Option<UsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default)]
    pub parameters: Vec<ComputationParameter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<ComputationEndpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attester: Option<ComputationEndpoint>,
    pub body: String,
    pub body_range: SourceRange,
    pub links: Vec<ConceptLink>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservedDocument {
    pub kind: String,
    pub reserved_kind: String,
    pub source: SourceDocument,
    pub body: String,
    pub body_range: SourceRange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frontmatter: Option<ParsedFrontmatter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub okf_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParseFailureReason {
    Decode,
    Frontmatter,
    Markdown,
    Read,
    ResourceLimit,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseFailure {
    pub kind: String,
    pub uri: String,
    pub bundle_path: String,
    pub reason: ParseFailureReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub code: String,
    pub category: String,
    pub severity: String,
    pub uri: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corrective_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedBundle {
    pub root_uri: String,
    pub revision: u64,
    pub concepts: Vec<Concept>,
    pub reserved_documents: Vec<ReservedDocument>,
    pub failures: Vec<ParseFailure>,
    pub findings: Vec<Finding>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum DocumentContent {
    Text(String),
    Bytes(Vec<u8>),
    InvalidUtf16 {
        #[serde(rename = "invalidUtf16")]
        _invalid_utf16: bool,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityOnlyFailure {
    pub reason: ParseFailureReason,
    pub message: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidUtf16DocumentFields {
    #[serde(default)]
    pub uri: bool,
    #[serde(default)]
    pub bundle_path: bool,
    #[serde(default)]
    pub content_hash: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleDocumentInput {
    pub uri: String,
    pub bundle_path: String,
    #[serde(default)]
    pub content: Option<DocumentContent>,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub identity_only_failure: Option<IdentityOnlyFailure>,
    #[serde(default)]
    pub invalid_utf16_fields: Option<InvalidUtf16DocumentFields>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseBundleInput {
    pub root_uri: String,
    #[serde(deserialize_with = "deserialize_revision")]
    pub revision: u64,
    pub documents: Vec<BundleDocumentInput>,
    #[serde(default)]
    pub invalid_root_uri_utf16: Option<bool>,
}

fn deserialize_revision<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Box::<RawValue>::deserialize(deserializer)?;
    parse_revision_json_number(raw.get())
        .ok_or_else(|| D::Error::custom("revision must be a non-negative integral JSON number"))
}

pub(crate) fn parse_revision_json_number(source: &str) -> Option<u64> {
    if let Some(revision) = exact_integral_json_number(source) {
        return Some(revision);
    }
    if let Ok(revision) = source.parse::<f64>()
        && revision.is_finite()
        && revision >= 0.0
        && revision.fract() == 0.0
        && revision <= u64::MAX as f64
    {
        return Some(revision as u64);
    }
    None
}

fn exact_integral_json_number(source: &str) -> Option<u64> {
    let (negative, unsigned) = source
        .strip_prefix('-')
        .map_or((false, source), |value| (true, value));
    let (coefficient, exponent_source) = unsigned
        .split_once(['e', 'E'])
        .map_or((unsigned, None), |(coefficient, exponent)| {
            (coefficient, Some(exponent))
        });
    let (whole, fraction) = coefficient.split_once('.').unwrap_or((coefficient, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }

    let mut digits = String::with_capacity(whole.len().saturating_add(fraction.len()));
    digits.push_str(whole);
    digits.push_str(fraction);
    if digits.bytes().all(|byte| byte == b'0') {
        return Some(0);
    }
    let exponent = exponent_source.map_or(Some(0), |value| value.parse::<i64>().ok())?;
    let decimal_position = i64::try_from(whole.len()).ok()?.checked_add(exponent)?;
    if decimal_position <= 0 {
        return None;
    }
    let decimal_position = usize::try_from(decimal_position).ok()?;
    if decimal_position < digits.len() {
        if !digits.as_bytes()[decimal_position..]
            .iter()
            .all(|byte| *byte == b'0')
        {
            return None;
        }
        digits.truncate(decimal_position);
    } else if decimal_position > digits.len() {
        if decimal_position > 20 && digits.bytes().any(|byte| byte != b'0') {
            return None;
        }
        digits.extend(std::iter::repeat_n('0', decimal_position - digits.len()));
    }
    let digits = digits.trim_start_matches('0');
    let revision = if digits.is_empty() {
        0
    } else {
        digits.parse::<u64>().ok()?
    };
    (!negative || revision == 0).then_some(revision)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_failed: Option<bool>,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computation: Option<String>,
    pub orphan: bool,
    pub broken_link_count: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub source_range: SourceRange,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokenLinkPresentation {
    pub source_id: String,
    pub label: String,
    pub raw_target: String,
    pub source_range: SourceRange,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphStatistics {
    pub concept_count: usize,
    pub edge_count: usize,
    pub orphan_count: usize,
    pub broken_link_count: usize,
    #[serde(serialize_with = "serialize_utf16_count_map")]
    pub type_counts: std::collections::BTreeMap<String, usize>,
    #[serde(serialize_with = "serialize_utf16_count_map")]
    pub tag_counts: std::collections::BTreeMap<String, usize>,
}

fn serialize_utf16_count_map<S>(
    counts: &std::collections::BTreeMap<String, usize>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let mut entries = counts.iter().collect::<Vec<_>>();
    entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
    let mut map = serializer.serialize_map(Some(entries.len()))?;
    for (key, value) in entries {
        map.serialize_entry(key, value)?;
    }
    map.end()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPayload {
    pub protocol_version: u8,
    pub revision: u64,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    #[serde(serialize_with = "serialize_utf16_backlinks")]
    pub backlinks: std::collections::BTreeMap<String, Vec<String>>,
    pub broken_links: Vec<BrokenLinkPresentation>,
    pub statistics: GraphStatistics,
}

fn serialize_utf16_backlinks<S>(
    backlinks: &std::collections::BTreeMap<String, Vec<String>>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    let mut entries = backlinks.iter().collect::<Vec<_>>();
    entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
    let mut map = serializer.serialize_map(Some(entries.len()))?;
    for (key, value) in entries {
        map.serialize_entry(key, value)?;
    }
    map.end()
}
