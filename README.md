# Graffiti Runner 3D (Refactored)

A browser-based 3D multiplayer drawing game rebuilt from the previous monolithic client into a modular, production-focused architecture with a vector-stroke drawing pipeline.

## Run

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm start
```

3. Open:

```text
http://localhost:3000/public/index.html
```

## New Architecture

```text
public/
  core/
    Renderer.js
    SceneManager.js
    CameraController.js
  game/
    PlayerController.js
    MovementSystem.js
    DrawingSystem.js
  network/
    SocketManager.js
    SyncSystem.js
  ui/
    UIManager.js
  utils/
    math.js
    rdp.js
  main.js
  script.js
```

## Rendering Upgrade

- Physically-correct renderer (`physicallyCorrectLights = true`, `useLegacyLights = false`)
- ACES filmic tone mapping and sRGB output
- PMREM-processed HDR environment lighting
- Directional sun + ambient + fill point light
- PCF soft shadows with tuned shadow frustum
- `MeshStandardMaterial` conversion/tuning for imported city meshes
- Lightweight post stack: `RenderPass` + `FXAA` + subtle bloom

## Drawing Optimization Strategy

The old decal-image pipeline was replaced with stroke vectors:

- Each stroke stores 2D local wall coordinates in a wall patch basis
- Input points are simplified using Ramer-Douglas-Peucker
- Simplified points are quantized (`q = 1000`) to compact integers
- Network sends only stroke deltas (`stroke:add`) instead of full textures
- Runtime rendering uses `Line2` (thickness + color support)
- Per-patch memory cap:
  - Max live strokes in geometry
  - Older strokes are baked into a patch canvas texture layer

This preserves editability for recent strokes while keeping draw calls and memory stable over long sessions.

## Performance Decisions

- Main loop is explicitly split into `update()` and `render()`
- Movement uses acceleration/deceleration and octree collision (low jitter)
- Camera uses damped third-person follow
- Frustum culling is enabled on world meshes
- Remote players use pooled meshes to avoid allocation churn
- Drawing hot path reuses temp vectors/ray objects
- Debug HUD includes FPS, draw calls, triangles, and heap usage (if available)

## Networking

- Socket-based real-time sync for players and stroke deltas
- REST bootstrap endpoint (`/api/state`) for initial strokes/players
- Stroke payload validation + persistence on server
- Erase packets broadcast as deltas to remove live strokes across clients

## Notes

- Legacy image-decal drawing endpoints were superseded by stroke packets.
- Existing old drawing files are not migrated into the new vector format automatically.

## GitHub Pages

This project can be hosted on GitHub Pages as a static frontend.

- For root URL `https://graffiti-gamedk.github.io/`, the repository name must be `graffiti-gamedk.github.io`.
- GitHub Pages does not host `server.js`; deploy backend separately for multiplayer persistence.
- Pages workflow file: `.github/workflows/deploy-pages.yml`
- Detailed setup: `DEPLOYMENT.md`
