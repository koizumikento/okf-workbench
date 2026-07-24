use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityOnlyFailure {
    pub reason: ParseFailureReason,
    pub message: String,
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
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseBundleInput {
    pub root_uri: String,
    pub revision: u64,
    pub documents: Vec<BundleDocumentInput>,
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
    pub type_counts: std::collections::BTreeMap<String, usize>,
    pub tag_counts: std::collections::BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPayload {
    pub protocol_version: u8,
    pub revision: u64,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub backlinks: std::collections::BTreeMap<String, Vec<String>>,
    pub broken_links: Vec<BrokenLinkPresentation>,
    pub statistics: GraphStatistics,
}
