# Feature Specification: HTML Preview Viewer

**Feature Branch**: `html-preview-viewer`
**Created**: 2026-07-02
**Status**: Draft
**Input**: "Agents need a way to preview generated HTML files (mockups, reports, dashboards) directly in BrowserOS without installing them as permanent apps."

> **Context**: Currently, agents can generate HTML content but lack a native mechanism to render it immediately for user review. Users must manually save files and open them via external means or install temporary apps. This feature introduces a dedicated `openHtmlViewer` tool that wraps HTML content in a secure, styled shell and renders it instantly.

## User Scenarios & Testing (Mandatory)

### User Story 1 - Agent Preview Workflow (Priority: P1)
An agent generates an HTML file (e.g., a mockup or report) and wants to show it to the user immediately.
**Acceptance Scenarios**:
1.  **Given** an HTML file exists at `/mockups/design.html`, **When** the agent calls `openHtmlViewer("/mockups/design.html")`, **Then** a new window opens displaying the content in a styled viewer shell.
2.  **Given** the file does not exist, **When** the tool is called, **Then** an error is returned to the agent with a clear message (e.g., "File not found: /mockups/design.html").

### User Story 2 - Viewer Shell UI (Priority: P1)
The preview window must look like a native BrowserOS app and provide basic controls.
**Acceptance Scenarios**:
1.  **Given** the viewer is open, **When** the user looks at the top bar, **Then** they see the filename (e.g., "design.html") and a close button (×).
2.  **Given** the content has no CSS, **When** rendered, **Then** it appears in a clean, dark-themed shell matching BOS styling (or inherits the file's theme if present).
3.  **Given** the content is interactive (JS), **When** rendered, **Then** it functions correctly within the iframe sandbox.

### User Story 3 - Temporary App Lifecycle (Priority: P2)
The preview should be treated as a temporary asset.
**Acceptance Scenarios**:
1.  **Given** a preview is opened, **When** the user closes the window, **Then** the underlying temporary app remains in the "Installed Apps" list but marked as "Preview" (or auto-uninstalls if configured).
2.  **Given** multiple previews are open, **When** the user opens another, **Then** each gets a unique ID and does not overwrite previous ones.

## Requirements (Mandatory)

### Functional Requirements

- **FR-001**: The system MUST expose a new tool named `openHtmlViewer` with the signature:
  ```typescript
  openHtmlViewer(filePath: string): Promise<{ windowId: string; appId: string }>
  ```
- **FR-002**: The tool MUST read the file content from the VFS. If the file is missing, it MUST throw a descriptive error.
- **FR-003**: The tool MUST wrap the raw HTML content in a "Viewer Shell" before rendering:
  - Add a header bar with the filename and a close button (`window.close()`).
  - Ensure the shell has `height: 100vh` and `overflow: hidden`.
  - Apply BOS dark theme defaults if the inner content lacks styling (optional but recommended).
  - Use an `<iframe>` with `srcdoc` or dynamic injection to render the content securely.
- **FR-004**: The tool MUST generate a unique App ID (e.g., `html-preview-${timestamp}`) and install the wrapped HTML as a runtime app using `installApp`.
- **FR-005**: The tool MUST immediately open the new window using `openWindow` and return the `windowId` and `appId`.
- **FR-006**: The viewer shell MUST sanitize the input HTML to prevent XSS attacks (e.g., by using a sandboxed iframe with restricted capabilities).
- **FR-007**: The tool MUST handle large files (up to 10MB) without performance degradation.

### Key Entities

- **Viewer Shell**: A wrapper HTML document that provides the UI chrome (header, close button) and styling for the preview.
- **Temporary App**: A runtime app created by `openHtmlViewer` with a unique ID. It is distinct from permanent apps installed via `buildApp`.
- **Preview Window**: The window instance displaying the temporary app.

## Success Criteria (Mandatory)

### Measurable Outcomes

- **SC-001**: An agent can successfully preview any HTML file in the VFS within 2 seconds of calling the tool.
- **SC-002**: The preview window renders correctly with the BOS dark theme shell.
- **SC-003**: Interactive content (JS/CSS) inside the preview functions as expected.
- **SC-004**: Error handling works correctly for missing or malformed files.

## Implementation Details

### Viewer Shell Template
The wrapper HTML should look like this:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${filename} - Preview</title>
  <style>
    /* BOS Dark Theme Defaults */
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f1f5f9; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
    .viewer-header { background: #1e293b; padding: 12px 24px; border-bottom: 1px solid #475569; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
    .viewer-title { font-size: 18px; font-weight: 600; color: #f1f5f9; }
    .close-btn { background: none; border: none; font-size: 24px; cursor: pointer; color: #94a3b8; transition: color 0.2s; }
    .close-btn:hover { color: #ef4444; }
    .viewer-content { flex: 1; overflow: hidden; position: relative; }
    iframe { width: 100%; height: 100%; border: none; background: white; }
  </style>
</head>
<body>
  <div class="viewer-header">
    <div class="viewer-title">${filename}</div>
    <button class="close-btn" onclick="window.close()">×</button>
  </div>
  <div class="viewer-content">
    <iframe srcdoc="${escapedContent}" sandbox="allow-scripts allow-same-origin"></iframe>
  </div>
</body>
</html>
```

### Tool Registration
The tool must be registered in the core tools index (e.g., `src/tools/index.ts`) and exposed to the agent runtime.

## Edge Cases & Constraints

- **Large Files**: If a file exceeds 10MB, the tool should warn the user or truncate the preview.
- **Malicious Content**: The iframe sandbox MUST restrict access to the parent window's DOM and cookies.
- **Concurrent Previews**: Multiple previews can be open simultaneously; each must have a unique ID.
- **File Updates**: If the source file changes while the preview is open, the viewer does NOT auto-refresh (requires manual reload or re-call).

## Dependencies

- `readFile` (VFS tool)
- `installApp` (Runtime app installation)
- `openWindow` (Window management)

## Future Enhancements (Out of Scope for MVP)

- **Auto-uninstall**: Automatically remove the temporary app when the window is closed.
- **Live Reload**: Watch the file for changes and refresh the iframe automatically.
- **Theme Detection**: Detect if the inner HTML has a light/dark theme and adjust the shell accordingly.