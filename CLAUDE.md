# ccu

A broadcast camera's processing chain with every knob out, as an FFGL **effect**
(`CC01`, shown as `SW CCU`) for Resolume Arena/Avenue. C++/GLSL, CMake MODULE →
universal `.bundle` (macOS) + Windows `.dll`. MIT.

Read `AGENTS.md` before changing the chain (`Model.h`, the two shaders in
`Shaders.cpp`), the control laws, the defaults or the harness's tolerances.

## Commands (CMake)
- Configure: `cmake -B build -DCMAKE_BUILD_TYPE=Release`
- Fast dev build: add `-DCMAKE_OSX_ARCHITECTURES=arm64`
- Universal (what ships, and what `verify.sh` builds): `cmake -B build-universal -DCMAKE_BUILD_TYPE=Release`
- Build: `cmake --build build --parallel 4`
- Install into Arena: `cmake --install build` — **not run from a session**, it writes
  into `~/Documents/Resolume Arena/Extra Effects`
- Render a frame offline: `./build/cctest --out /tmp/f.png --size 1920x1080`
- Set anything by name: `--set "Detail Level=0.5" --set "Matrix=2" --set "Knee On=0"`
  (0..1 for sliders, the element index for Matrix, 0/1 for the booleans)
- List parameters, kinds, defaults and ranges: `./build/cctest --list`
- The exact GLSL the plugin compiles: `./build/cctest --dump-shaders DIR`
- Footage through the real shaders — **`--pipe`**, raw RGBA frames in, raw RGBA frames
  out, with `--size WxH`, `--fps N` (the synthetic clock the drift runs on) and an
  optional `--script` of `frame Parameter Name value` cues. Sliders ramp linearly
  between a name's cues; **Matrix, Knee On and Show Detail step** (each cue's value
  holds until the next cue's frame). Both hold before the first cue and after the
  last. A cue naming no parameter exits 2 before any frame; a partial frame at the end
  of stdin ends the stream with exit 0; a failed render or a closed stdout exits 1
  (SIGPIPE is ignored so a closed stdout is a failed write, not a 141):
  `ffmpeg … -f rawvideo -pix_fmt rgba - | ./build/cctest --pipe --size 1920x1080 [--script cues.txt] | ffmpeg …`

## Verify
- Everything: `tools/verify.sh` (fresh universal build + glslc + the offline checks +
  every rendered check at 320x180 AND 1280x720 + the --pipe contract + the sweep + the
  bundle, ~3 min)
- Every stage at its null returns the input, alpha bitwise, and after a resize: `./build/cctest --identity`
- A step's overshoot is Detail Level × h / 4 for exactly the spacing: `./build/cctest --detail`
- Below Coring no detail; above it the overshoot less the dead zone: `./build/cctest --coring`
- The knee's slope, continuity and per-channel action: `./build/cctest --knee`
- The OETF at three exponents; Black Gamma below its level only: `./build/cctest --gamma`
- WB before the knee, the knee before the clip: `./build/cctest --order`
- The skin window's gain inside, outside, and on a neutral: `./build/cctest --skin`
- The checks can fail: `./build/cctest --negative`; one perturbation verbosely:
  `./build/cctest --order --perturb 2` (bits in `Model.h`)
- No GL (what CI runs first): `./build/cctest --offline` = `--laws --names`
- Every rendered check takes `--size WxH`; CI runs them at 320x180 with `--allow-no-gl`
- Shaders through glslc: `tools/check-shaders.sh build/cctest`
- No dead controls: `python3 tools/sweep.py` (`--size WxH`, `--jobs N`)
- Render cost: `./build/cctest --bench` (720p, 1080p, 4K; best of three; the GPU is
  shared, so run it twice)
- What a host sees: `~/Projects/resolume/oxbow/build/oxbow probe build-universal/CCU.bundle`

## Notes
- **The shaders ARE the chain.** Each stage lives once, in GLSL (`Shaders.cpp`): the
  linear pass (linearise, master gain, white balance, matrix; luma in alpha) into an
  RGBA32F buffer, then the process pass (detail, knee, gamma, black gamma, pedestal,
  white clip, mix) into the host's framebuffer. The C++ converts sliders to uniforms
  (`Controls.cpp`) and computes the OETF's constants, the matrix and the drift in
  double (`Ccu.cpp`, `Model.h`). The harness restates every law and holds the shaders
  to it.
- **Master Gain is head-end gain, in linear light, before white balance** — not a
  video gain after gamma. A CCU's dB gain is sensor gain, and putting it there is what
  lets the knee catch a gained-up highlight. AGENTS.md has the decision.
- **The OETF is a family with the exponent as the control**: a and k follow from it by
  continuity at 0.018, and at 0.45 they are BT.709's 1.099 / 4.5 to the standard's
  printed precision (the harness asserts it). The linearise uses the same family at
  0.45, so the round trip is exact in principle.
- **Every detail tap is `texelFetch`**, two per far tap with a hand lerp for a
  fractional spacing, clamped to the picture. Nothing rests on a texture unit's
  filtering, and a whole spacing is `( 1 - 0 ) a + 0 b`, which is `a` exactly.
- **The mix is written out** as `v * Mix + src * ( 1 - Mix )`, not `mix()`: the
  identity check needs `Mix = 1` to be exactly `v`.
- **Coring is in units of edge height** (an edge lower than Coring gets no detail), so
  the dead zone on the detail signal is Coring / 4.
- **The drift is an Ornstein–Uhlenbeck walk in double on the CPU** (τ 20 s, seeded
  through the PCG hash by frame), scaled by the Drift control at use, so a slider move
  never jumps the state. The clock is clamp's: unit voted, origin + offset in double.
- **Skin Hue's ends are the same hue**, so the sweep compares 0 with 180 degrees.
- **Parameter names must be unique and 16 characters or under** — hence `Crispening
  Freq` and `Level Dependence` (exactly 16).
- `SetParamInfo` clamps a STANDARD default into 0..1; `SetParamInfof` reads its default
  out of `params[]`, so fill `params[]` first. Matrix is mapped by index in
  `Model.h` (an option's range reads back 0..1).
- Override `SetTextParameter` to return FF_SUCCESS for the About block, or no host can
  instantiate the plugin at all.
- `ccu_core` is an OBJECT library, not STATIC — the plugin registers itself from a
  file-scope constructor nothing references by name.
- `FFGLScopedFBOBinding.h` is not in the umbrella header; include `<ffglex/FFGLScopedFBOBinding.h>`.
- `FFGLShader::Set` has no mat3 overload: the matrix goes in with `glUniformMatrix3fv`
  transposed (row-major on the CPU).
- macOS build must be universal. Verify with `lipo`, never the build log.
- FFGL id is `CC01`, display name `SW CCU`.

## Not done yet
- **Never loaded into Resolume.** Everything numeric is measured offline on macOS,
  plus an `oxbow` load. Footage seen only through `--pipe` (nine of Resolume's demo
  clips), judged by eye.
- No Windows run, no win-lab gate, no Arena gate (v0.1.0 is local).
- No OpenFX port, no browser demo, no factory presets, no luma knee (the knee is per
  channel only), no audio input.
- `StoatworksAbout.h` and `ATTRIBUTIONS.md` are provisional hand copies with
  `guide=""`; the release step registers the project and re-runs the syncs.

## Diagnostics

`source/Diag.{h,cpp}` — log file only, no crash handler (this runs inside Resolume).

    ~/Library/Logs/ccu/ccu.YYYY-MM-DD.log        (macOS)
    %LOCALAPPDATA%\ccu\logs\ccu.YYYY-MM-DD.log   (Windows)
