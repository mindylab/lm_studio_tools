# Local Web MCP Tool

Local Web MCP Tool gives LM Studio models simple public web access without API keys.
It runs as a local MCP server over stdio.

## Tools

- `web_search`: search the web and return titles, URLs, snippets, and publish dates when available.
- `web_fetch`: fetch one URL and extract readable text.
- `youtube_transcript`: extract a YouTube transcript from a URL or video id without launching a browser, including the video cover image URL.
- `qr_generate`: generate a QR code PNG image from text, URLs, Wi-Fi payloads, or contact cards.
- `qr_scan`: scan a QR code from a PNG/JPEG image URL, local file path, data URL, or base64 image.
- `web_page_to_images`: render one URL in Chromium and return full-page screenshot image(s).
- `web_search_and_fetch`: search, then fetch the top results in one call.

## Requirements

- Node.js 20.19 or newer.
- Network access for Brave Search, Bing RSS fallback, YouTube transcript requests, target web pages, and optional `r.jina.ai` reader fallback.

## Install

From this folder, install dependencies.

Windows PowerShell:

```powershell
cd C:\path\to\simple_web_tool
npm.cmd install
```

Linux:

```bash
cd /path/to/simple_web_tool
npm install
```

Check that the source parses:

Windows PowerShell:

```powershell
npm.cmd run check
```

Linux:

```bash
npm run check
```

Install the Chromium browser used by `web_page_to_images`:

Windows PowerShell:

```powershell
npm.cmd run browsers:install
```

Linux:

```bash
npm run browsers:install
```

## LM Studio Setup

LM Studio can open the MCP config from `Program > Install > Edit mcp.json`.
The file is normally here:

| OS | Path |
| --- | --- |
| Windows | `%USERPROFILE%\.lmstudio\mcp.json` |
| Linux | `~/.lmstudio/mcp.json` |

Print a ready-to-copy config for the current folder:

Windows PowerShell:

```powershell
npm.cmd run mcp:config
```

Linux:

```bash
npm run mcp:config
```

Add the `local-web` entry inside the existing `mcpServers` object. Keep any existing server entries already in that file.

Windows example:

```json
{
  "mcpServers": {
    "local-web": {
      "command": "node",
      "args": [
        "C:/path/to/simple_web_tool/src/index.js"
      ],
      "timeout": 60000
    }
  }
}
```

Linux example:

```json
{
  "mcpServers": {
    "local-web": {
      "command": "node",
      "args": [
        "/path/to/simple_web_tool/src/index.js"
      ],
      "timeout": 60000
    }
  }
}
```

If your `mcp.json` already has servers, merge it like this:

```json
{
  "mcpServers": {
    "existing-server": {
      "command": "..."
    },
    "local-web": {
      "command": "node",
      "args": [
        "/path/to/simple_web_tool/src/index.js"
      ],
      "timeout": 60000
    }
  }
}
```

Example snippets are available in `examples/`.
After saving `mcp.json`, restart LM Studio or reconnect MCP servers from LM Studio settings.

## Optional Settings

Set these environment variables before LM Studio starts the MCP server if you want to tune behavior:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LM_WEB_MCP_FETCH_TIMEOUT_MS` | `20000` | Per-request fetch timeout in milliseconds. |
| `LM_WEB_MCP_DEFAULT_MAX_CONTENT_CHARS` | `12000` | Default maximum page text returned by `web_fetch`. |
| `LM_WEB_MCP_MAX_DOWNLOAD_BYTES` | `5000000` | Maximum response size the server will download. |
| `LM_WEB_MCP_DEFAULT_QR_WIDTH` | `768` | Default generated QR PNG width and height in pixels. |
| `LM_WEB_MCP_MAX_QR_TEXT_CHARS` | `4000` | Maximum text length accepted by `qr_generate`. |
| `LM_WEB_MCP_MAX_QR_IMAGE_BYTES` | `10000000` | Maximum PNG/JPEG image size accepted by `qr_scan`. |
| `LM_WEB_MCP_ASSET_PORT` | `8765` | Local HTTP port used to expose generated screenshots/QR images to chat clients when LM Studio cannot persist MCP image files. |
| `LM_WEB_MCP_PUBLIC_BASE_URL` | auto LAN URL | Optional public base URL for generated image links, for example `http://192.168.9.211:8765`. |
| `LM_WEB_MCP_DISABLE_ASSET_SERVER` | unset | Set to `1` to disable the generated-image asset server. |
| `LM_WEB_MCP_SEARCH_COUNTRY_CODE` | `us` | Default search country, such as `us`, `gb`, or `de`. |
| `LM_WEB_MCP_SEARCH_LANGUAGE` | `en-US` | Default search language hint. |
| `LM_WEB_MCP_ENABLE_JINA_FALLBACK` | `1` | Set to `0` to disable `r.jina.ai` reader fallback. |
| `LM_WEB_MCP_USER_AGENT` | `local-web-mcp/0.1 ...` | User agent sent during web requests. |

## Manual Run

LM Studio normally starts the MCP server for you. For a quick manual smoke test:

Windows PowerShell:

```powershell
npm.cmd start
```

Linux:

```bash
npm start
```

The server uses stdio, so it will wait for an MCP client and may look quiet in the terminal.

## QR Tools

`qr_generate` returns both text metadata and PNG image content, so chat clients can display the QR code directly.
The `text` input can be a URL, Wi-Fi payload, contact card, payment URI, or any normal QR payload.

`qr_scan` reads PNG and JPEG images from:

- `imageUrl`
- `imagePath`
- `imageBase64`

Provide exactly one image source. For local files, only scan paths the user provided or explicitly asked to inspect.

## Page Screenshots

`web_page_to_images` opens the URL in headless Chromium and returns rendered screenshot image content.
By default it:

- Uses a `1280x900` viewport.
- Waits for the page to load.
- Scrolls through the page to trigger lazy-loaded content.
- Captures the full scrollable page.
- Splits very tall pages into multiple images.

Useful options include `viewportWidth`, `viewportHeight`, `format`, `segmentHeight`, and `maxPageHeight`.
Full-page capture is forced by default; use `viewportOnly: true` only when you explicitly want just the top/current visible viewport.
If Chromium fails to launch on Linux because system libraries are missing, run:

```bash
npx playwright install --with-deps chromium
```

On some Linux ARM systems, GPU/Vulkan drivers can make Chromium log errors like
`failed to open device /dev/dri/renderD128`. The screenshot tool launches its own headless Chromium
with GPU and sandbox disabled by default so browser capture does not touch the GPU path. Keep LM
Studio itself configured for your normal model-inference GPU backend.

If the terminal prints `[1]+ Stopped`, the app was suspended by the shell, usually from `Ctrl+Z`.
Resume it with:

```bash
fg
```

## Troubleshooting

- Make sure `node` is available in the same PATH LM Studio uses.
- On Windows, `where node` shows the Node.js executable path.
- On Linux, `which node` shows the Node.js executable path.
- Use absolute paths in `mcp.json`.
- If `web_page_to_images` cannot find Chromium, run `npm run browsers:install`.

## System Prompt

Use `docs/system-prompt-sample.md` as a starting prompt so the model knows when to use the web tools, when not to use them, and how to cite or explain sources.
