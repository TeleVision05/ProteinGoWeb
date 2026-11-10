# GLB AR Lab

A developer test site for checking how far you can push 3D models in mobile WebXR AR. It finds the floor, places a GLB model on it, and lets you walk around the model while the page logs the frame time, GPU work, memory and tracking stats.

Stack: plain ES modules and three.js r187 (loaded from a CDN with an import map), so there's no build step.

## Run it

```bash
python serve.py            # HTTPS on :8443, self-signed cert, phone on same Wi-Fi
python serve.py --http     # HTTP on :8000 (desktop, or phone via USB port forwarding)
```

### Option A: Wi-Fi (simplest)
1. Run `python serve.py`. It prints `https://<your-LAN-IP>:8443/`.
2. On the phone (Android + Chrome + ARCore), open that URL, tap **Advanced → Proceed** past the self-signed cert warning.
3. If the phone can't connect, allow Python through Windows Firewall (private networks) when prompted.

### Option B: USB (no cert warning, full remote DevTools)
1. Run `python serve.py --http`, connect the phone over USB with USB debugging enabled.
2. On the PC open `chrome://inspect` → **Port forwarding** → `8000` → `localhost:8000`.
3. On the phone open `http://localhost:8000`. Localhost counts as a secure context, so WebXR works without HTTPS. The console, performance panel and `window.lab` debug handle are then available from `chrome://inspect`.

Platform note: WebXR `immersive-ar` + hit-test works in **Chrome on ARCore Android phones**. iOS Safari does not expose WebXR AR (Apple routes web AR through AR Quick Look/USDZ instead), so on iPhone this page only runs in preview mode.

## Using it

1. Pick a model (or open any local `.glb`). It loads before AR starts, and the card shows download, decode and shader compile times.
2. Choose the **AR resolution scale** (0.5×, 0.75×, 1×, or native). This is the single biggest GPU lever.
3. **Enter AR**, then point at the floor. The reticle turns green on horizontal surfaces, and the hint shows how far the surface is below the phone. Tap to place.
4. The model gets locked and an **XRAnchor** is created so it stays put while ARCore refines its map as you walk. Tap **Move** to reposition it.

Controls: `−`/`+` size, `⟳` rotate, `1:1` file units as metres, `+copy`/`−copy` (add or remove copies that share GPU geometry; use this to stress-test triangle and draw-call throughput), `Anim`, `Shadow` (blob → shadow map → off), `Mat` (original PBR → Lambert → unlit → normals, to isolate fragment cost), `Hz` (target refresh rate, only on devices that report supported rates), `HUD` (compact → full → off), `Log`, `Bench 10s`, `Report`.

## Stats

| Stat | Meaning |
|---|---|
| fps / frame / p95 / max | From XR frame timestamps over the last 1 s. Colour is relative to the target Hz. |
| 1% low | Average fps of the slowest 1% of frames over the last 10 s. This is the stutter metric. |
| long | Frames longer than 1.5× the target frame time. |
| cpu | JS time per frame (hit-test, anchors, animation, and three.js submitting the draw calls). |
| gpu | `EXT_disjoint_timer_query_webgl2`. Usually **n/a on phones**, where you have to infer GPU load (fps drops while cpu stays low). |
| draws / tris / pts | `renderer.info` for the last frame. |
| geom / tex / prog / heap | GPU resources held by three.js, plus JS heap (Chrome only). |
| Model | Vertices, triangles, meshes, materials, textures, **geometry memory** (bytes uploaded to the GPU), animations, glTF extensions. |
| Load | File size, transfer size, download, parse+decode, shader compile. |
| XR | Framebuffer resolution and megapixels, scale, foveation, blend mode, DOM overlay, enabled features, frame rate. |
| Tracking | Tracking state, lost count, surface state, anchor status, **anchor fixes** (corrections over 2 cm), distance to the model, phone height above the placement. |

- **Bench 10s** records frame times and reports avg, 1% low, min, p50/p95/p99, cpu and gpu, triangles, draw calls and min/avg/max distance. The result is sent to the PC automatically.
- **Report** builds a JSON report (live stats, all sections, benchmarks, the last 20 s of frame times, and the log). With `serve.py` it lands in `reports/`. On a static host it downloads to the phone instead.
- The log and a stats line every 5 s stream to the `serve.py` terminal, so you can watch the numbers on the PC while walking around.

## Adding models

```bash
npm install                                      # once (needs Node 20+)
npm run add-model -- "C:/path/to/thing.glb" "Thing"
```

This copies the source into `models/src/`, writes `-meshopt` and `-draco` variants, and registers all three in `models/models.json`. You can also open any `.glb` directly with the file picker without converting it.

## Research: making glTF fast in mobile WebXR

### The baseline model
| Variant | File | Over the wire (gzip) | GPU geometry | Decode (desktop) |
|---|---|---|---|---|
| Original Blender export | 142 MB | 12.9 MB | 136 MB | ~80 ms |
| **Meshopt + quantized** | 18 MB | **1.9 MB** | **57 MB** | ~55 ms |
| Draco | 4 MB | 1.3 MB | 114 MB | ~450 ms |

All three variants have 1.12M triangles, 2.94M vertices, 4 meshes and 1 animation.

**Use meshopt + quantization (`gltf-transform optimize --compress meshopt`) as the default.** Draco gives the smallest file, but it decodes back to float32, so it uses **2× the GPU memory** and takes **~8× longer to decode**. Meshopt keeps quantized int16/int8 attributes (`KHR_mesh_quantization`) all the way to the GPU. That roughly halves VRAM and vertex fetch bandwidth, which is what matters on mobile. Meshopt is designed to be paired with gzip/brotli on the server, and that's where its large wire-size savings come from.

### Ranked levers (largest effect first)
1. **Triangle and vertex count.** Mobile GPUs comfortably handle roughly 0.5–2M triangles per frame in AR. Beyond that, frame time scales with vertex work. For molecular models the biggest win is upstream: lower sphere subdivision, or switch from atom spheres to ribbon/surface representations. Automatic simplification (`--simplify`) does little on thousands of tiny closed spheres, because it can't simplify them without deleting atoms. Use LOD variants when you need both close-up detail and distant performance.
2. **Pixel count (resolution scale).** The phone's camera-sized framebuffer is the main fill-rate cost. `framebufferScaleFactor` 0.75 cuts the pixel count by about 44%. Compare 0.5/0.75/1/native in the benchmark to find the knee. Fixed foveation mostly helps headsets and is usually ignored on phones.
3. **Draw calls.** Keep these under ~100–200 on mobile. Merge meshes and materials (`gltf-transform optimize` joins them), and use `InstancedMesh`/`EXT_mesh_gpu_instancing` for repeated parts. Each copy here adds 4 draw calls.
4. **Shaders.** Full PBR (MeshStandardMaterial with an environment map) costs the most per pixel. Lambert or unlit with baked lighting is much cheaper. Use the `Mat` toggle to measure the difference on your phone.
5. **Shadows.** A real shadow map re-renders all geometry from the light's view, roughly doubling vertex cost for dense meshes. A blob/contact shadow quad is nearly free and gives most of the grounding effect.
6. **Textures.** Use KTX2/Basis (`--texture-compress ktx2`). These stay compressed in VRAM (about 4–8× less memory than PNG/JPEG), and they skip main-thread image decode. Keep textures ≤2K on phones. This model has none, but most PBR assets do.
7. **Antialiasing.** MSAA in WebXR AR costs bandwidth on tile-based GPUs. It's off by default, so toggle it and measure.
8. **Avoid hitches.** Use `renderer.compileAsync()` before showing the model (done here), avoid allocations in the frame loop, and keep DOM overlay updates infrequent (the HUD redraws at 4 Hz).
9. **Delivery.** Serve with gzip/brotli and long cache headers, and stream from a CDN. On cellular, the raw export is 142 MB uncompressed (12.9 MB gzipped) versus 1.9 MB for meshopt+gzip, and the parse and upload costs grow with the raw size too.

### Why three.js (and not WebGPU or other engines)
- WebXR AR on Android is a WebGL2 path. three.js WebGPURenderer XR support is still incomplete and not available on phones for AR, so WebGL2 is the most compatible option today.
- `<model-viewer>` is great for "show a product in AR", but its AR mode hands off to native Scene Viewer or Quick Look, which aren't web rendering and don't expose stats, so it's no use for measuring web performance.
- Babylon.js is a fine alternative with similar performance. three.js was chosen for its smaller footprint and because its WebXR, meshopt and KTX2 support is first-class.

### Sources
- [glTF Transform `optimize` CLI](https://gltf-transform.dev/cli) and [meshoptimizer](https://meshoptimizer.org/)
- [WebXR performance optimization workflow (Meta)](https://developers.meta.com/horizon/documentation/web/webxr-perf-workflow/)
- [three.js WebXRManager docs](https://threejs.org/docs/pages/WebXRManager.html)
- [100 Three.js performance tips (2026)](https://www.utsubo.com/blog/threejs-best-practices-100-tips)
- [WebXR Hit Test](https://immersive-web.github.io/hit-test/), [Anchors](https://immersive-web.github.io/anchors/), [DOM Overlays](https://immersive-web.github.io/dom-overlays/) specs
