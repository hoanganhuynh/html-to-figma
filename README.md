# HTML to Figma — Local Plugin

Chuyển HTML (file hoặc URL) thành Figma layers với độ chính xác cao.

## Kiến trúc

```
Figma Plugin UI
    ↓ fetch POST
Local Server (Node.js + Playwright)  ← chạy ngầm trên máy bạn
    ↓ headless Chromium
Render trang → DOM walk + computed styles
    ↑ JSON layer tree + base64 images
Figma Plugin → tạo nodes trên canvas
```

## Cài đặt

### Bước 1 — Cài dependencies

```bash
npm install
cd packages/server && npm install && cd ../..
cd packages/plugin && npm install && cd ../..
```

### Bước 2 — Cài Playwright browsers

```bash
cd packages/server && npx playwright install chromium && cd ../..
```

### Bước 3 — Build plugin

```bash
cd packages/plugin && npm run build && cd ../..
```

---

## Chạy

### Terminal: khởi động server

```bash
cd packages/server && npm start
```

Server lắng nghe tại `http://localhost:3333`. Giữ terminal này mở khi dùng plugin.

### Figma: load plugin

1. Mở Figma Desktop
2. Menu → **Plugins** → **Development** → **Import plugin from manifest...**
3. Chọn file: `packages/plugin/manifest.json`
4. Chạy plugin từ **Plugins → Development → HTML to Figma**

---

## Sử dụng

Plugin có 3 tab:

| Tab | Mô tả |
|-----|-------|
| **URL** | Nhập URL website (public hoặc localhost) |
| **HTML File** | Kéo thả / chọn file `.html` |
| **HTML Code** | Paste code HTML trực tiếp |

Chọn viewport (Desktop / Tablet / Mobile) rồi nhấn **Import**.

---

## Dev mode (auto-rebuild khi sửa code)

```bash
cd packages/plugin && npm run dev
```

---

## Cấu trúc project

```
packages/
  server/
    src/
      index.js      — HTTP server + Playwright logic
      capture.js    — DOM walk script (inject vào browser)
  plugin/
    src/
      code.ts       — Figma plugin main thread
    ui/
      index.html    — Plugin UI (3 tabs)
    manifest.json
    dist/           — Built output (load vào Figma)
```

---

## CSS → Figma mapping hiện tại

| CSS | Figma |
|-----|-------|
| `background-color` | `fills` (SOLID) |
| `background-image: url(...)` | `fills` (IMAGE) |
| `border` | `strokes` |
| `border-radius` | `cornerRadius` |
| `box-shadow` | `effects.dropShadow` |
| `display: flex` | Auto Layout |
| `font-*` | TextNode styles |
| `opacity` | `opacity` |
| `overflow: hidden` | `clipsContent` |
| `<svg>` elements | `createNodeFromSvg` |
| `<img>` | image fill |
