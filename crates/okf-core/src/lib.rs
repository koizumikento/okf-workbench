//! Deterministic Open Knowledge Format semantics shared by the editor and CLI.
//!
//! This crate intentionally has no filesystem, terminal, editor, Webview, network, or
//! asynchronous runtime dependency. Callers enumerate documents and apply change plans.

mod graph;
mod model;
mod parser;
mod templates;
mod validation;

pub use graph::build_graph_payload;
pub use model::*;
pub use parser::parse_bundle;
pub use templates::{
    AgentTarget, BundlePreset, ConceptTemplateInput, IndexMode, RenderedFile, agent_files,
    agent_files_checked, agent_files_provider_checked, bundle_preset_files,
    bundle_preset_files_checked, concept_template_file, concept_template_file_checked, index_files,
};
pub use validation::{is_future_minor_version, validate_bundle};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ABI_VERSION: u32 = 1;
pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "operation", content = "input")]
pub enum CoreRequest {
    Metadata,
    Inspect(InspectInput),
    Parse(ParseBundleInput),
    Validate(ValidateInput),
    Graph(ParseBundleInput),
    RenderBundle(RenderBundleInput),
    RenderConcept(ConceptTemplateInput),
    RenderIndexes(RenderIndexesInput),
    RenderAgent(RenderAgentInput),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectInput {
    pub bundle: ParseBundleInput,
    pub now: String,
    #[serde(default)]
    pub failures: Vec<ParseFailure>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateInput {
    pub bundle: ParsedBundle,
    pub now: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderBundleInput {
    pub preset: BundlePreset,
    pub timestamp: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderIndexesInput {
    pub bundle: ParseBundleInput,
    pub mode: IndexMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderAgentInput {
    pub target: AgentTarget,
    #[serde(default = "default_bundle_path")]
    pub bundle_path: Value,
}

fn default_bundle_path() -> Value {
    Value::String(".".to_owned())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreResponse {
    pub abi_version: u32,
    pub core_version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CoreErrorBody>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreErrorBody {
    pub code: &'static str,
    pub message: String,
}

impl CoreResponse {
    fn success<T: Serialize>(value: T) -> Self {
        match serde_json::to_value(value) {
            Ok(result) => Self {
                abi_version: ABI_VERSION,
                core_version: CORE_VERSION,
                result: Some(result),
                error: None,
            },
            Err(error) => Self::failure("serialization-failed", error.to_string()),
        }
    }

    fn failure(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            abi_version: ABI_VERSION,
            core_version: CORE_VERSION,
            result: None,
            error: Some(CoreErrorBody {
                code,
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    abi_version: u32,
    core_version: &'static str,
    capabilities: [&'static str; 7],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Inspection {
    bundle: ParsedBundle,
    findings: Vec<Finding>,
    graph: GraphPayload,
}

/// Dispatch one versioned JSON request without granting the core any ambient capability.
pub fn dispatch_json(request_json: &str) -> String {
    let request = match serde_json::from_str::<CoreRequest>(request_json) {
        Ok(request) => request,
        Err(error) => {
            return serialize_response(CoreResponse::failure(
                "invalid-request",
                format!("The OKF core request is invalid: {error}"),
            ));
        }
    };

    let response = match request {
        CoreRequest::Metadata => CoreResponse::success(Metadata {
            abi_version: ABI_VERSION,
            core_version: CORE_VERSION,
            capabilities: [
                "parse",
                "validate",
                "graph",
                "bundle-template",
                "concept-template",
                "indexes",
                "agent-template",
            ],
        }),
        CoreRequest::Inspect(input) => {
            if validation::parse_reference_time(&input.now).is_none() {
                return serialize_response(CoreResponse::failure(
                    "invalid-request",
                    "ValidationOptions.now must be a valid Date or ISO date-time string.",
                ));
            }
            let mut bundle = parse_bundle(input.bundle);
            bundle.failures.extend(input.failures);
            if let Some(message) = graph::inspect_prevalidation_graph_error(&bundle) {
                return serialize_response(CoreResponse::failure("graph-resource-limit", message));
            }
            bundle.failures.sort_by(|left, right| {
                left.bundle_path
                    .cmp(&right.bundle_path)
                    .then_with(|| left.uri.cmp(&right.uri))
            });
            let findings = validate_bundle(&bundle, &input.now);
            bundle.findings.clone_from(&findings);
            if let Some(message) = graph::bounded_graph_input_error(&bundle) {
                return serialize_response(CoreResponse::failure("graph-resource-limit", message));
            }
            let graph = build_graph_payload(&bundle);
            if let Some(message) = graph::graph_payload_size_error(&graph) {
                return serialize_response(CoreResponse::failure("graph-resource-limit", message));
            }
            CoreResponse::success(Inspection {
                bundle,
                findings,
                graph,
            })
        }
        CoreRequest::Parse(input) => CoreResponse::success(parse_bundle(input)),
        CoreRequest::Validate(input) => {
            if validation::parse_reference_time(&input.now).is_none() {
                CoreResponse::failure(
                    "invalid-request",
                    "ValidationOptions.now must be a valid Date or ISO date-time string.",
                )
            } else {
                CoreResponse::success(validate_bundle(&input.bundle, &input.now))
            }
        }
        CoreRequest::Graph(input) => {
            let bundle = parse_bundle(input);
            if let Some(message) = graph::bounded_graph_input_error(&bundle) {
                CoreResponse::failure("graph-resource-limit", message)
            } else {
                let graph = build_graph_payload(&bundle);
                if let Some(message) = graph::graph_payload_size_error(&graph) {
                    CoreResponse::failure("graph-resource-limit", message)
                } else {
                    CoreResponse::success(graph)
                }
            }
        }
        CoreRequest::RenderBundle(input) => {
            match bundle_preset_files_checked(input.preset, &input.timestamp) {
                Ok(files) => CoreResponse::success(files),
                Err(message) => CoreResponse::failure("invalid-request", message),
            }
        }
        CoreRequest::RenderConcept(input) => match concept_template_file_checked(&input) {
            Ok(file) => CoreResponse::success(file),
            Err(message) => CoreResponse::failure("unsafe-relative-path", message),
        },
        CoreRequest::RenderIndexes(input) => {
            let mut bundle = parse_bundle(input.bundle);
            if matches!(input.mode, IndexMode::Missing) {
                // The ABI mirrors the TypeScript renderer, which plans against an empty
                // existing-index set and leaves collision/merge handling to its caller.
                bundle.reserved_documents.clear();
            }
            CoreResponse::success(index_files(&bundle, input.mode))
        }
        CoreRequest::RenderAgent(input) => {
            let rendered = match input.bundle_path {
                Value::String(path) => agent_files_checked(input.target, &path),
                Value::Object(path)
                    if path.get("pathIdentity").and_then(Value::as_str) == Some("provider") =>
                {
                    path.get("relativePath")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "A non-empty provider-relative path is required.".to_owned())
                        .and_then(|path| agent_files_provider_checked(input.target, path))
                }
                _ => Err("A non-empty relative path is required.".to_owned()),
            };
            match rendered {
                Ok(files) => CoreResponse::success(files),
                Err(message) => CoreResponse::failure("unsafe-relative-path", message),
            }
        }
    };
    serialize_response(response)
}

fn serialize_response(response: CoreResponse) -> String {
    serde_json::to_string(&response).unwrap_or_else(|_| {
        r#"{"abiVersion":1,"coreVersion":"unknown","error":{"code":"serialization-failed","message":"The OKF core response could not be serialized."}}"#.to_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_is_versioned() {
        let response: Value =
            serde_json::from_str(&dispatch_json(r#"{"operation":"metadata"}"#)).unwrap();
        assert_eq!(response["abiVersion"], 1);
        assert_eq!(response["result"]["abiVersion"], 1);
        assert_eq!(response["error"], Value::Null);
    }

    #[test]
    fn invalid_json_is_data_not_a_panic() {
        let response: Value = serde_json::from_str(&dispatch_json("{")).unwrap();
        assert_eq!(response["error"]["code"], "invalid-request");
    }

    #[test]
    fn graph_operation_rejects_an_unsafe_revision() {
        let response: Value = serde_json::from_str(&dispatch_json(
            r#"{"operation":"graph","input":{"rootUri":"","revision":9007199254740992,"documents":[]}}"#,
        ))
        .unwrap();
        assert_eq!(response["error"]["code"], "graph-resource-limit");
        assert_eq!(
            response["error"]["message"],
            "The graph revision must be a non-negative safe integer."
        );
    }
}
