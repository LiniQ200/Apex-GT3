# APEX GT3

**Play live in your browser (WebGPU / WebGL 2):** https://liniq200.github.io/Apex-GT3/

Race nine opponents over three laps of Autodromo Valle d’Oro, or select **Hotlap qualifying** for a solo session. Choose a GT3 chassis (`458 GT3 Evo` NA V8 or `Concept GT3 Prototype` Twin-Turbo Flat-6), factory livery, starting tyre compound, **Rear Wing Aero** (`Low Drag` / `Balanced` / `High Downforce`), and **Brake Bias** (`54%` / `57%` / `60%`) in Competition Garage Bay 01, then **Drive**. Wait for all five red lights to go out. The pit wall shows upcoming turns, weather-adjusted entry speeds, and cars alongside.

**Driving:** W/S or ↑/↓ for throttle and brake, A/D or ←/→ to steer. C changes camera, B looks back, V cycles live weather (Clear Midday, Golden Hour, Twilight Dusk, Overcast/Damp, Heavy Rain), P opens the MoTeC Pit Strategy MFD, L toggles the 60 km/h pit limiter, T/Y adjust TC and ABS (0–10), R rejoins if there is space, and Esc pauses. Touchscreens have two-thumb steering and pedals. Gamepads use the left stick and triggers.

In the cockpit, read the upgraded MoTeC LCD instruments, live 320×96 mirrors, and animated single-arm carbon wiper with WGSL+GLSL raindrops. Select **MoTeC C127** to toggle the full telemetry pod featuring a live **2.0G friction circle**, color-coded **4-corner tyre & brake-rotor thermals**, fuel, slipstream `TOW`, and TC/ABS status.

## Play online or download a release

Phones and computers open the same 3D game. Use a current browser with WebGPU or WebGL 2 and graphics acceleration. The engine runs a single locked **Native 1080p Direct Forward PBR** pipeline with 4× hardware MSAA, 16× anisotropic texture filtering, Khronos PBR Neutral tone mapping, 3-cascade texel-stabilized sun shadows (2 cascades on software adapters), 7 cross-backend WGSL/GLSL shaders (mirror-wet puddle reflections & raindrop ripples on crushed-basalt asphalt, dual-tone automotive metallic paint flop & autoclave 2×2 gloss carbon, volumetric 4-octave drifting clouds with Henyey-Greenstein silver lining, GPU foliage wind & backlit leaf translucency, cockpit windshield raindrops & airflow rivulets with synchronized GT3 wiper arc, manicured Tuscan terrain & Apennine limestone cliffs, blackbody carbon-ceramic brake rotors, titanium skid-block sparks, and GPU cloth flags), and strictly zero motion blur or muddy post-processing. Drag in Competition Garage Bay 01 to orbit the car. Devices without either graphics API cannot run this game.

If launch stalls, select **Launch with WebGL 2** on the loading screen. This runs the same cars, lighting and circuit without waiting for a WebGPU device. Open the link directly in your browser if an embedded preview blocks 3D graphics.

For offline play, download the full game from the garage’s **Controls** panel and extract the entire ZIP. Run `python3 play.py` in the extracted folder (`py play.py` on Windows). It starts a loopback-only server and opens your browser. Leave the terminal open until you finish. Alternatively, serve the extracted root from any static HTTP server. Double-clicking `index.html` shows these launch instructions.

## Build from source

Use Node.js 22.12 or newer and `npm ci`. `npm run dev` starts the development server. `npm run build` checks TypeScript, builds the 3D site under `dist/`, and packages the same game in `dist/downloads/apex-gt3.zip`. `npm run preview` serves those files. For WebGPU on a hosted site, use HTTPS. Run `bun test ./src` for unit/Jolt physics tests, `npm run verify:orb -- --full-profile --webgpu` / `--webgl2` / default 3-lap sprint for rendered verification, and `node scripts/check-platforms.mjs` / `node scripts/check-session.mjs` against a running preview for failover and session regressions.

Dev and build prepare any missing assets. To prepare deliberately offline after installing the locked packages, use `npm run fetch:assets -- --offline`. When connectivity returns, `npm run fetch:assets` replaces available substitutions. No keys or third-party requests are needed while playing. See `public/credits.txt` for the car, scenery, engine and font credits.
