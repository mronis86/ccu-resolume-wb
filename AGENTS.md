# AGENTS.md — CCU

Onboarding for whoever (or whatever) picks this up next. `CLAUDE.md` is the short
command reference; this is the *why*. Read "What is actually verified" before you
tell anybody this works.

---

## What the plugin is

A broadcast camera's processing chain with every knob out, as an FFGL 2.1 effect
(`CC01`, shown as `SW CCU`) for Resolume Arena and Avenue. C++17 + GLSL 4.10, CMake,
universal macOS `.bundle` and a Windows `.dll`. MIT, intended home
`github.com/stoatworks-labs/ccu`.

Built 2026-09-24 in one session from the fleet's templates and `specs/SPEC-ccu.md`
(with `BRIEF.md` and `BRIEF-ADDENDUM.md`, tranche four): toner (by way of slope and
clamp) for the harness, the verify script, the `--pipe` contract, the negative-control
pattern, `--offline` and the GL-less CI; clamp for the clock; plumbicon for the plugin
shape, the Diag logger and the About block; tinsel for `PassBuffer` and the trap list;
graticule for the notes and the provisional About. Plumbicon is the tube in front of
this chain; this is the processing behind it.

---

## The one idea

**The "video" look of a studio or OB camera is not a filter. It is a processing chain
in a fixed order, each stage a known circuit with the knob a shader on the CCU panel
turned.**

Put the stages in the right order, in linear light, label the knobs as a CCU labels
them, and the badly set-up camera looks fall out rather than being drawn:

| stage | what it does | where |
| --- | --- | --- |
| linearise | the inverse BT.709 OETF: the clip stands in for scene light (an assumption, stated) | `kLinear` |
| master gain | head-end gain in dB, in linear light (below) | `kLinear` |
| white balance | R and B gains about G, plus a slow seeded drift in mireds | `kLinear`, `Ccu.cpp` |
| matrix | Saturation( 2p ) · a preset 3×3, in linear light; the luma of the result into alpha | `kLinear`, `Model.h` |
| detail | the ( −¼, ½, −¼ ) kernel on the luma at ±spacing, horizontally from pixel delays and vertically from line delays; cored; reduced below a luma level; suppressed in a hue window; added to all three channels | `kProcess` |
| knee | above the point a gentler slope, continuous at the point, per channel | `kProcess` |
| gamma | the OETF with the exponent as the control, a and k following by continuity | `kProcess` |
| black gamma | a smooth lift below 0.25 video, zero at and above it | `kProcess` |
| pedestal, white clip | Master Black added on video; min( V, White Clip ); floor at 0 | `kProcess` |
| mix | written out as `v · Mix + src · ( 1 − Mix )` | `kProcess` |

| what the chain does | what comes out |
| --- | --- |
| a high-passed copy from delays, added back | **halos** the width of the delay, not of the edge: a step overshoots by Level × h / 4 for exactly the spacing, each side |
| a dead zone on the detail signal | **coring**: below it the grain is left alone; a low setting sharpens the noise, a high one plastic-coats the picture |
| a hue window on the detail gain | **skin detail**: faces go soft while the jacket stays sharp |
| the knee after white balance | **a warm white compresses in R** instead of clipping; with the knee off it **clips in R first** |
| an Ornstein–Uhlenbeck walk on the R and B gains | **drifting white balance**, as a warming-up camera did |

### What does not fall out, and is the honest limit

- **The clip stands in for scene light.** An 8-bit clip's white is the top of what the
  chain ever sees; a real camera's knee has a scene two or three stops brighter than
  white to compress. Master Gain and the R/B gains are what push anything above 1.0,
  and the knee's whole character on footage comes from them.
- **The knee is per channel only.** The spec offered a luma knee with chroma preserved
  as an option; it is not here. A per-channel knee is what most cameras call "knee",
  and it is the one whose colour behaviour `--order` measures.
- **The skin window is on the linear colour's hue**, not on a camera's (R−Y, B−Y)
  chroma vector after the matrix and gamma. The window is flat inside ¾ of its width,
  smoothstepped to 0 at the width, and gated on chroma so a neutral is never skin.
- **The vertical detail uses the same spacing as the horizontal.** A real camera's
  line delays are whole lines; here a fractional spacing lerps between lines too.
- **The drift's mired-to-gain law is a judged constant** (0.4% of R/B ratio per
  mired), not a Planckian locus.

---

## The shape of the code

| File | What it is |
| --- | --- |
| `source/Model.h` | The chain, described; the constants; the `Perturb` bits; the OETF family; the matrices and their derivations; the drift's step; the option table. |
| `source/Controls.{h,cpp}` | Every slider to its physical unit, written so the nulls are exact. |
| `source/Shaders.{h,cpp}` | The vertex shader and the two passes. **The shaders are the chain.** |
| `source/Ccu.{h,cpp}` | The plugin: parameters, the buffer, the constants in double, the two passes, the test hooks. |
| `source/Clock.{h,cpp}` | clamp's clock, unchanged: unit voting, origin + offset in double. |
| `source/PassBuffer.*` | tinsel's FFGLFBO with the leak fixed. |
| `source/Diag.{h,cpp}` | A log file, for the shader that will not compile. |
| `tools/cctest/` | The offline harness: renders, measures, benchmarks, pipes, dumps shaders. |
| `tools/check-shaders.sh` | glslc on the dumped shaders; verify.sh and CI both call it. |
| `tools/sweep.py` | No control is silently dead. |
| `tools/verify.sh` | All of it, at two rasters, plus the release-time checks done locally. |

One buffer: the linear picture, RGBA32F at picture size (32 MB at 1080p, 127 MB at
4K), Nearest, read with `texelFetch`. Nothing else carries across a pass and nothing
on the GPU carries across a frame.

---

## Traps

Roughly in the order they will bite.

### The "last lifted column" of a curve that goes to zero smoothly is raster-dependent

`--gamma`'s black-gamma assertion first said "the last column below 0.25 is lifted and
the first at 0.25 is not". At 320 wide that held; at 1280 wide column 319 sits so close
to the level that its predicted lift, which goes as ( 1 − u )², is 9e-7 — under the
3.6e-6 tolerance — and the assertion failed on a correct plugin. The check now compares
the measured last-lifted column with the *predicted* last column whose lift exceeds the
tolerance. This is exactly the addendum's class of failure and it was found by running
at two rasters, which is why verify.sh does.

### A flat grey cannot tell Show Detail on from off

The first `--pipe` step test cued Show Detail on a flat grey frame and compared frame
hashes. On a flat grey the detail signal is zero, so the view is 0.5 and the picture is
0.502, both 128 in 8 bits: frames 0, 4 and 8 were identical whether the boolean stepped
or ramped, and the test could not fail. It now uses a frame with an edge, holds the
slider by `--set`, and has a second script proving a slider *does* ramp.

### Inherited from the fleet, and all still true here

`ScopedFBOBinding` does not restore the viewport (the host's is captured first and
restored before the process pass, with the host's FBO bound explicitly); every
`ffglex::Scoped*` clears to 0 on exit, so the one `Ensure()` happens before anything
binds a texture; `FFGLFBO::Release()` leaks the colour texture (`PassBuffer::Destroy()`
deletes it first); `SetParamInfo` clamps a STANDARD default into 0..1 and
`SetParamInfof` reads its default out of `params[]`; an option's range reads back 0..1
whatever its element count; the core is an **OBJECT** library; `SetTextParameter` must
return `FF_SUCCESS` for the About block; `FFGLShader::Set` has no mat3 overload
(`glUniformMatrix3fv`, transposed); `nm | grep -q` fails under pipefail when grep
succeeds; a closed stdout must be a failed write, so `--pipe` ignores SIGPIPE; zsh has
no `PIPESTATUS`, so `verify.sh` is bash; Resolume's clock overflows a float, so the
drift only ever sees a dt from clamp's `Clock`; `mix( x, y, 1 )` and `pow( 1, 1 )` are
not relied on to be exact anywhere — the mix is written out, and the identity check's
bound *includes* the round trip's pow.

---

## Would this hold on another rasteriser, at another raster?

One line per check. Every tolerance is derived, not fitted; every check ran at 320×180
and 1280×720 in `verify.sh`.

What makes them rasteriser-proof by construction: **every detail tap is `texelFetch`
at an integer coordinate** (`ivec2( gl_FragCoord.xy )`, and the far taps lerped by hand
from two fetches), so nothing rests on a texture unit's filtering or an interpolated
uv except the read of the host's picture at a texel centre; **every constant is computed
on the CPU in double** and handed over as a float uniform, and the harness's statement
of each law is rounded through the same float; **the only GPU transcendentals in a
checked path are the two `pow`s of the round trip** (and one `atan` whose value the
skin check never sits near the edge of); **nothing sums over pixels**.

The tolerance, `tolerance( V )`, is derived in `cctest` from GLSL 4.10 §8.2: `pow` is
`exp2( y · log2( x ) )`, `log2` has 3 ULP outside [0.5, 2] and an absolute 2⁻²¹ inside,
`exp2` 3 ULP, each multiply and add ½ ULP, and the linear intermediate is stored as a
float. That is walked through the decode, the store and the encode per sample, doubled,
plus 4 kU (kU = 2⁻²⁴). It comes to **3.57e-6 at white**, and the check asserts it never
exceeds 2e-5 so nobody can quietly loosen it.

| check | what it measures | tolerance and where it comes from | raster dependence |
| --- | --- | --- | --- |
| `--identity` | every rgb sample of a three-ramp picture against itself; alpha bitwise; a grey ramp through Saturation 1.8 + High Saturation; the same instance resized | `tolerance( V )` above; for the grey through a matrix, plus the OETF slope × 8 kU (the luma weights summing to 1 in three roundings) | none; the resize adds 33×11 to the raster |
| `--detail` | the Show Detail view against the stated kernel per pixel; the peak against Level × h / 4; the run length against ceil( spacing ); the fractional pixel against f × that; the output against OETF( L + D ) | view: 32 kU (14 roundings of values ≤ 1: the luma dot, two lerps, the kernel, the level, the 0.5); output: `tolerance( V )` + OETF slope × ( level × 16 kU + 4 kU ) + 4 kU | none; the edge is at W/2 and the window ±( 2s + 4 ) |
| `--coring` | the view per pixel with the dead zone; the peak against Level × ( h − Coring ) / 4; below Coring, zero both sides | 32 kU as above (the dead zone is one subtract and one max) | none |
| `--knee` | the output per column against OETF( knee( L ) ); the slope in recovered linear light between columns W/4 apart; the slope below 1; no column-to-column step beyond the ramp's own; a colour patch per channel; knee off is the identity | `tolerance( V )` + slope × 6 kU per column; the measured slope's tolerance is the two columns' linear tolerances over their separation (3.5e-5 at 320, 8.6e-6 at 1280) | the slope tolerance shrinks with W; the continuity test compares each step with the ramp's own step at that W |
| `--gamma` | the output per column against OETF( g L ) at +6 dB (both segments); against OETF₀.₃₅ and OETF₀.₅₅; Black Gamma 1 against the stated lift; the last lifted column against the predicted last; nothing lifted at or above 0.25 | `tolerance( V, g )` / `tolerance( V, 1, o )`; the lift adds 12 kU (6 roundings) | the last-lifted column is compared with the prediction at this W (the trap above) |
| `--order` | R at +6 dB through the knee against WB-then-knee; the knee-then-WB prediction ≥ 20 tolerances away and the plugin ≥ 10 from it; G through the knee alone; knee off, R exactly 1.0 and G, B at their OETF | `tolerance( V, gR )` + slope × 6 kU; the clip's exactness is `min()` returning its operand, asserted to kU | none (a flat field) |
| `--skin` | the view per pixel at gain 0.25 inside the window, 1 outside, 1 on a neutral; the peaks | 48 kU: the coloured luma, three lerps, the window products; the window's 1 and 0 are exact because `smoothstep` clamps and the hue sits at the centre or 90° away | none |
| `--laws` | 22 laws at 21 points; the exact nulls; the OETF at 0.45 against BT.709's printed constants; the round trip in double; both segments meeting; Saturation( 1 ) exactly I; white preserved by every preset; the Standard matrix against Poynton's to 2e-3; HueRotate orthonormal; the drift's variance | 1e-12 relative; exact; 5e-4 on a, 0.01 on k | none (no GL) |

Deliberately NOT relied on: `mix( a, b, 1 ) == b` (the mix is written out); `pow( 1, 1 )
== 1` (the identity bound includes the pow); exact cancellation anywhere; a texture
unit's filtering (all taps `texelFetch`); interpolated varyings (only the host read);
the 8-bit readback (the harness reads floats); GLSL integer division of a negative
operand (none occurs; the taps are clamped before the fetch).

What might still differ on another rasteriser: a driver whose `pow` is worse than the
spec's 3 + 3 ULP would eat into the identity margin (the measured worst is 0.07 of the
tolerance here, so there is room for one that is fourteen times worse); `atan` has no
accuracy promise in GLSL 4.10, which is why the skin check never puts a hue near the
window's edge; `check-shaders.sh` covers the syntax on a second compiler and the
rendered checks run with `--allow-no-gl` so a runner without a context skips loudly.

### The negative controls

`cctest --negative` runs eight against the rendered checks; `--perturb BITS` runs any
check verbosely against one. Each perturbs the *plugin's* shaders or uniforms — a
`Perturb` bitmask the shipped plugin carries at zero — never the harness's expectation.

| perturbation | what fails, measured at 320×180 and 1280×720 |
| --- | --- |
| the linearise a plain 2.2 power (the chain in gamma space) | `--identity`: all 3 (worst 0.2 against 3.6e-6); `--order`: 3 |
| the knee before white balance | `--order`: 2 — the plugin lands on the knee-then-WB prediction |
| coring's dead zone removed | `--coring`: 5 — the 0.02 edge overshoots by 0.005 |
| the detail kernel doubled | `--detail`: 14 — every peak twice its prediction |
| the knee slope 10% steeper | `--knee`: 3 — the per-column match, the slope, the patch |
| the skin window ignored | `--skin`: 2 — the inside patch at full gain |
| the OETF exponent 0.05 high | `--gamma`: 5 (6 at 1280) |

### The mutation

One character of the shipped GLSL, on a clean committed tree (`5c6c60c` +
`verify.sh`): in the process pass's `encode`, `OetfA * pow( l, OetfGamma ) - OetfC` →
`+ OetfC`, so every encoded value above the break is 0.198 too high. Caught at 320×180
and 1280×720 by **`--identity`** (3 of 7: worst error 0.198, 153 000 tolerances),
**`--detail`** (4 of 18: the four through-the-chain output assertions; the Show Detail
view has no OETF in it and stayed right), **`--knee`** (6 of 7), **`--gamma`** (6 of 7)
and **`--order`** (4 of 6). **`--coring` and `--skin` did not catch it**, and should
not: both read the Show Detail view, which is the detail signal about mid grey with no
encode in its path. Reverted with `git checkout source/Shaders.cpp`; the tree was clean
before and after; `--identity --gamma` passed again on the rebuilt binary (14 checks,
0 failed).

---

## Decisions taken without asking

- **Master Gain is head-end gain, in linear light, before white balance.** The spec's
  step 7 lists it with the pedestal and the clip; a CCU's dB gain is sensor gain and a
  gained-up highlight is what the knee exists to catch, so it is applied first. Range
  −6 .. +18 dB, exactly 0 dB at slider 0.25.
- **The OETF is a family in its exponent.** Gamma sets the exponent (0.35 .. 0.55,
  exactly 0.45 at the middle) and a, k follow by continuity at 0.018. At 0.45 that is
  1.0991 / 4.5068 against the standard's printed 1.099 / 4.5 (`--laws` asserts the
  agreement); the linearise uses the same family at 0.45 so the round trip is exact in
  principle. Chosen over "BT.709's constants plus a power trim" because a trim's pow of
  1.0 is not the identity and a CCU's gamma knob really does set the exponent.
- **Black gamma is a polynomial bump on video**, V + BG × 1.5 × 0.25 × u( 1 − u )²
  below 0.25, exactly zero at the control's null and at the level, with zero slope at
  the level. No pow, so nothing rests on `pow( x, 1 )`.
- **Coring is in units of edge height** (0 .. 0.25 linear, squared for resolution at
  the bottom): an edge lower than Coring gets no detail, because a step of h peaks at
  h / 4. The dead zone on the signal is Coring / 4.
- **Detail Level is 3p**; the kernel's step peak is ¼, so an edge of h overshoots by
  3p × h / 4. Crispening Freq is 1 + 8p pixels, whole at every eighth of the slider.
- **H/V Ratio is one control**: H = min( 1, 2p ), V = min( 1, 2( 1 − p ) ), both
  exactly 1 at the middle.
- **Level Dependence** scales detail by 1 − LD ( 1 − min( 1, Y / 0.2 ) ).
- **The skin window** is a hue half-width of 5 .. 60° about Skin Hue, flat inside ¾ of
  it, smoothstepped to the edge, gated by a chroma smoothstep 0.05 .. 0.15. Hue is the
  angle of the linear chroma vector, 0 at red, 60 at yellow; skin is about 16°.
- **The knee is per channel, in linear light**: point 0.4 .. 1.0, slope 0.05 .. 1
  (exactly 1 at the top). No luma knee.
- **Matrix presets are derivations with generic names**: Identity; Standard = SMPTE
  170M primaries → BT.709 primaries from the chromaticities (checked against Poynton's
  published matrix to 4e-5); High Saturation = Saturation( 1.35 ); Film-like =
  Saturation( 0.82 ) · HueRotate( +4° ) about the grey axis. The last two numbers are
  judged. The list is in enum order, not alphabetical.
- **The drift is an Ornstein–Uhlenbeck walk**, unit variance, τ = 20 s, driven by
  Box–Muller on the PCG hash of ( seed, frame ), stepped by the clock's dt in double.
  The Drift control scales the walk at use (60 mireds RMS at 1), and a mired moves the
  R and B gains by e^( ±0.004 × mired ). The default 0.15 is 9 mireds RMS: visible over
  a minute, never a jump.
- **Master Black** is 0.2( p − 0.25 ): −0.05 .. +0.15 video, exactly 0 at 0.25. **White
  Clip** is 1 + 0.3( p − 0.5 ): 0.85 .. 1.15, exactly 1 at 0.5.
- **The defaults** are a camera somebody set up in a hurry: Detail Level 0.9 at a 2 px
  delay, Coring at an edge of 0.0225, Level Dependence 0.5, Skin Detail 0.4 at 20° ±20°,
  the knee on at 0.7 linear with a 0.29 slope (so white lands at 0.90 video and the top
  of the picture goes milky), Black Gamma 0.2, the Standard matrix, Drift 0.15. Judged
  on nine of Resolume's demo clips (below): halos on the bright edges, hot spots
  compressed to a milky grey, the noise floor kept by the coring. Not a flood and not a
  blank.
- **Options and booleans step between `--pipe` cues; sliders ramp.** `valueAt` takes a
  `steps` flag from the parameter's type, and `verify.sh` proves both.
- **`--fps` sets the synthetic clock's rate** for `--out` and `--pipe`, so a reel
  filmed at 50 fps drifts at 50 fps.
- **`--fail-render-at N`** is a harness-only hook so `verify.sh` can prove `--pipe`
  exits 1 on a failed render.
- **The hero is the test card at the defaults**, rendered by the harness, not a demo
  clip: Resolume's media is theirs.
- **About and attributions are generated** (`StoatworksAbout.h`, `ATTRIBUTIONS.md`):
  hand copies adapted from toner's until the release registered the project, then the
  backend's `sync-about.py` and `sync-attributions.py` wrote them, adding the User guide
  button (28 parameters, four of them About). Never edit them by hand.
- **pi is `kPi` in `Model.h`**, spelt out: MSVC has no `M_PI` without
  `_USE_MATH_DEFINES`, and two siblings' first Windows CI runs failed on it.
- **The FFGL submodule was dissociated from the reference clone** (`repack -a -d`, the
  alternates file removed) so this repo does not depend on a path in `~/Projects`.

---

## What is actually verified, and what is assumed

### Verified by measurement, on an M4 Max running macOS 26.4 (2026-09-24)

Every number is `tools/verify.sh` on this machine against a fresh universal Release
build, at 320×180 and 1280×720 (identical at both unless said).

- **Identity.** Worst error **1.19e-7** over a three-ramp picture, 0.06–0.07 of its
  derived tolerance (largest 3.57e-6); alpha bitwise; a grey ramp through Saturation
  1.8 and High Saturation to 1.79e-7; the same after a resize to 353×191 / 1313×731.
- **Detail.** Four cases (2 px H, 2.5 px H, 3 px V, 1.5 px V): the view matches the
  kernel to 1.49e-8 (0.01 of tolerance); overshoot and undershoot **0.096795** against
  Level × h / 4 = 0.096795 (h = 0.3872); the run lasts exactly ceil( spacing ) pixels
  (2, 3, 3, 2); the fractional pixel carries f × the peak (0.048397); the output through
  the chain to 6.61e-8.
- **Coring.** An edge of 0.02 below Coring 0.04: exactly zero both sides (uncored it
  would be 0.005). An edge of 0.20: overshoot **0.040000** against Level × ( h − c ) / 4.
- **Knee.** Point 0.40, slope 0.2400: per column worst 1.26e-7; measured slope
  **0.24000** above and **1.00000** below; no column steps more than the ramp; R at 0.8
  linear compressed to 0.70257 with G and B untouched to 6e-8; knee off is the identity.
- **Gamma.** +6 dB per column worst 1.67e-7 with 13 (320) / 52 (1280) columns on the
  linear segment; exponents 0.35 (a 1.1895, k 5.669) and 0.55 (a 1.0520, k 3.528) to
  1.7e-7; Black Gamma 1 to 1.19e-7, lifting up to column 79 / 318 and not from 80 / 320,
  largest lift 0.0556.
- **Order.** R at +6 dB through the knee **0.831815** against WB-then-knee 0.831815;
  knee-then-WB would be 0.997004, **34 605 tolerances** away; G 0.704139 as predicted;
  knee off, R **exactly 1.0000000** while G and B stay at 0.9000.
- **Skin.** Gain **0.25** inside (overshoot 0.012127 against 0.012127), **1.00** with the
  window 90° away (0.048507), **1.00** on a neutral (0.062500); worst 2.7e-8.
- **Negative controls.** All eight fail their check, at both rasters.
- **Mutation.** Caught by five checks at both rasters (above).
- **No dead controls**, all 23, with the four About entries skipped.
- **Every shader compiles** through `glslc`, all 3, as the plugin hands them to the
  driver.
- **`--pipe`** returns exactly two frames for two and a half, refuses an unknown cue
  with 2, exits 1 on a failed render and on a closed stdout (`| head -c 1`), steps a
  boolean cue and ramps a slider cue.
- **The bundle** is universal (`x86_64 arm64`), exports `_plugMain`, carries
  `com.stoatworks.ffgl.ccu`, ad-hoc signs, and `oxbow` reports `SW CCU` / `CC01` /
  `effect`, 27 parameters in eight groups, and renders 120 frames through `plugMain`.
- **Render cost**, best of three runs of 60 frames after a warm-up, `glFinish` both
  sides, on a shared GPU, default controls, two runs:

  | | ms/frame | % of a 60fps frame |
  | --- | --- | --- |
  | 1280×720 | 0.06 | 0.3 |
  | 1920×1080 | 0.17 | 1.0 |
  | 3840×2160 | 0.68 – 0.70 | 4.1 |

  Two passes, eight texel fetches a pixel; it is cheap.
- **On footage, by eye only:** nine of Resolume's bundled demo clips (Beat 001, Bass
  003, Synth 004, Trinity_09, IntoTheGlow_02, OrganicMotions_06, FogAndDust_3,
  NeonRoom2_32, Metalive 01) through `--pipe` at the defaults, one frame each at
  960×540, viewed beside the source and in 1:1 crops. Bright edges carry a halo of the
  delay's width; hot spots and white backgrounds compress to a milky 90%; fine dark
  texture is left alone by the coring. It reads as a hot broadcast camera, not a broken
  one. BattleWeapon_Tank_09 is shorter than the 3 s seek and was not rendered.

### Assumed, or not done

- ☠️ **Never loaded into Resolume on macOS.** Everything was compiled, rendered and
  measured offline against the real plugin class in a headless CGL context, plus an
  `oxbow` load.
- **Windows: run once, in Resolume Arena 7.27.1 on win-lab** (Mesa llvmpipe, no GPU, 2026-09-24): the CI DLL loads, registers as `SW CCU` / `CC01` / effect, all 29 host controls match the declaration, it renders, all 24 valued controls move the picture, Arena's log is clean, 9/9 (`plugin-bench/arena/expect/ccu.json`). Never on a Windows GPU, and nothing timed there.
- **Footage judged by eye**, not measured: all 33 demo clips at the defaults, and the
  release video.
- **Not verified at 4K**, only benchmarked there.
- **The drift has never been watched over a minute** in a host; its statistics are
  checked (`--laws`) and its effect at 60 frames is swept, and that is all.
- **No OpenFX port.** The browser demo is a port of the shaders with the CPU half
  re-implemented in JavaScript; nothing checks that port but a reader.
- **Nothing has been through a show.**

### Found filming the release video (2026-09-24)

The video is `cctest --pipe` over Resolume's bundled demo clips
(`stoatworks-backend/video/projects/ccu/render.py`). Every one of the 33 clips was put
through the defaults first: nothing floods or blanks, the dark clips (Bass, Synth,
Ethnik2, SpaceUniverse) stay dark because the chain is the identity at black, and the
defaults stood. Two things the footage taught:

- **A warm white with the knee off does not give cyan edges.** The first draft of the
  guide said so, from reasoning about "red clips first". What the picture does: red
  reaches the ceiling first, so the *core* of each highlight loses its warmth and goes
  white inside a warm surround. With the knee on, red is compressed instead and the
  highlight stays warm all the way up. The guide, README and the video's caption say
  the second thing now.
- **A clip whose own colour moves confounds a matrix step.** Metalive's gold ball goes
  white and back through its loop, so the presets read as the clip changing. The matrix
  beat uses Galactucity's dancers, whose orange and blue hold still.

---

## Open questions

- **Should the knee point be stated in video percent** (85–100%, as a CCU labels it)
  rather than in linear light? The harness would convert through the OETF in double
  either way; the operator's number would change.
- **Should there be a luma knee with chroma preserved**, as a second Knee mode? The
  spec offered it; the per-channel knee is what `--order` is about.
- **Should Master Gain sit where the spec listed it** (after gamma, as a video gain)?
  It is head-end gain here, and the reason is written above; a proc-amp gain is a
  different knob and could be added as one.
- **Should the vertical detail delay be whole lines only?** A camera's is; the shared
  spacing keeps one control.
- **Should the skin window be on the post-gamma chroma vector** rather than the linear
  hue? That is where a camera's skin detector lives; the linear hue is where the detail
  is computed.
- **Should the drift be per-instance seeded** so two layers do not drift together?

---

## The browser demo

`demo/` is the page at **ccu-demo.stoatworks-labs.com**, a static-assets Worker
deployed from `wrangler.toml` with `cf-run npx wrangler deploy` and by
`.github/workflows/deploy.yml` on every push to main (no build step; what is
committed is what is served). `demo/vendor/` is the shared kit from
`stoatworks-backend/resolume-demo/` and is not edited here. The host is a Worker
**route** plus a proxied `AAAA 100::` DNS record, not a custom domain: the zone
hit Cloudflare's 100-custom-domain limit on 2026-09-24. Delete that record and
the page goes dark while deploys stay green.

The page runs the plugin's three shaders (`kVertex`, `kLinear`, `kProcess`),
copied across unedited: `demo/tools/check_shaders.py` compares them with
`source/Shaders.cpp` character for character and `tools/verify.sh` fails if one
drifts. **What is a port** is everything the C++ computes on the way to a
uniform, written out again in JavaScript doubles in `demo/plugin.js`:
`Controls.cpp` function for function; `Model.h`'s closed forms — the OETF's a
and k from the exponent by continuity at 0.018 (and the inverse at exactly
0.45), the 3×3 per preset as a derivation (Saturation, Rodrigues' hue rotation
about grey, SMPTE 170M to BT.709 primaries through `PrimariesToXYZ` and the
inverse) times the Saturation control, and the drift's PCG hash, Box–Muller
normal and Ornstein–Uhlenbeck step; and `Ccu::ProcessOpenGL`'s two draws with
their uniforms. **Nothing checks that port but a reader**: `cctest` proves the
C++ and the GLSL and has never heard of the page. Change any of those and change
`demo/plugin.js` by hand to match. `pow`, `exp`, `log`, `cos` and `sqrt` are the
JavaScript engine's rather than libm's and may differ in the last bit.

What the page does differently, all of it said on the page:

- **The clock is the kit's**, not `Clock.cpp`'s: seconds accumulated from the
  page's frame deltas (clamped to 0.1 s), paused and stepped by the transport.
  The drift's dt is the difference of two readings; a backwards reading (Restart)
  is treated as the plugin's jump, one nominal frame of 1/60 s. The walk starts
  at zero with the plugin's own seed, so a reload replays the same walk.
- **The linear buffer is RGBA32F**, as in the plugin, through
  `EXT_color_buffer_float`; the kit refuses to start without it rather than
  running the chain on 8-bit linear light. Sampled NEAREST with `texelFetch`.
- `MaxUV` is `( 1, 1 )` (the kit's clips are never padded) and the host's
  viewport is the whole canvas at the clip's size, which the process pass's
  `texelFetch` at `gl_FragCoord` assumes.
- The 3×3 goes to the GPU column-major with transpose false, where the C++ hands
  `glUniformMatrix3fv` a row-major array with `GL_TRUE`. Same nine slots.
- `Perturb` is held at 0, what the shipped plugin carries: the seven negative
  controls are not on the page. The About block is absent, as on every page in
  the suite. No audio caveat: CCU has no audio path. The clips carry no face, so
  the skin window acts on whatever hue falls inside it.

Decided without asking, for the page: the synthetic scene leads the clip list
(a hot sun for the knee, hard edges for the detail, warm colours for the skin
window), bars and the ramps read the knee and the OETF as numbers; the presets
are the page's own (the plugin ships none), expressed entirely in its parameters;
a line under the canvas reports the drift as the port is stepping it; and the
docs sections landed after v0.1.0 was tagged, because the demo is not in the
binary and needs no tag. Verified 2026-09-24 headlessly (SwiftShader): the page
loads with no console errors, all 23 controls in seven groups, and the picture
changes with Show Detail and with Detail Level. The only console error on the
live page is Cloudflare's injected `/cdn-cgi/challenge-platform` script refused
by the page's `script-src 'self'`, known fleet-wide and not the page's.

---

## Siblings

- **toner**, by way of **slope** and **clamp** — the harness, verify, CI and `--pipe`
  shapes, the negative controls, `--offline`, the AGENTS.md shape.
- **clamp** — the clock.
- **plumbicon** — the plugin shape, Diag, the About block, and the tube this chain
  sits behind.
- **old-cathode** — a long signal path with grouped controls; the display this chain
  feeds.
- **tinsel** — `PassBuffer`, `sweep.py`, and the fleet's trap list.
- **graticule** — the notes, and the provisional About.
- **oxbow** — `oxbow probe` and `oxbow selftest` are what load this bundle as a host.
