# Shared protocol boundary

This directory owns the serializable, versioned extension/Webview message contract and its
hand-written runtime decoders. It intentionally imports neither VS Code nor DOM APIs.

The Webview never sends a source URI back to the extension host. An `openSource` action contains
only the current graph revision and node ID; the host resolves that pair against its authoritative
graph before opening a workspace resource.
