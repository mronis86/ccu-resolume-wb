# Attributions

CCU is built on other people's work. This file lists what that work is, who did
it, and what it is doing here.

This is a PROVISIONAL hand copy (2026-09-24). The real file is generated — the
master lists live in the `stoatworks-backend` repo and are pushed out by
`scripts/sync-attributions.py` once the project is registered. Edit it there, not here.

## Code we derived from other people's work

Someone else solved this first, and this project would not exist in its current form without their work.

### Harness shape, --pipe contract and verify — Stoatworks toner, slope and clamp

<https://github.com/stoatworks-labs/clamp>  
Licence: MIT  
Copyright: Stoatworks Labs

The harness shape, the --pipe contract (SIGPIPE ignored, a closed stdout is exit 1), the negative-control pattern, --offline, check-shaders.sh, the verify script, the sweep and the CI workflows are clamp's, by way of slope and toner.

### The clock — Stoatworks clamp

<https://github.com/stoatworks-labs/clamp>  
Licence: MIT  
Copyright: Stoatworks Labs

`Clock.{h,cpp}` unchanged: the host's clock unit voted on, an origin and an offset in double, so a Resolume clock that overflows a float never reaches the drift as anything but a dt.

### PassBuffer and the trap list — Stoatworks tinsel

<https://github.com/stoatworks-labs/tinsel>  
Licence: MIT  
Copyright: Stoatworks Labs

The off-screen buffer wrapper over the SDK's FFGLFBO (reallocating only when the size changes, freeing the colour texture the SDK's Release() leaks) and the FFGL trap list that came with it, by way of toner.

### The camera model's partner — Stoatworks plumbicon

<https://github.com/stoatworks-labs/plumbicon>  
Licence: MIT  
Copyright: Stoatworks Labs

The plugin shape, the Diag logger and the About block are plumbicon's; plumbicon is the tube in front of this chain and this is the processing behind it.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### Resolume FFGL SDK

<https://github.com/resolume/ffgl>  
Licence: BSD-3-Clause  
Copyright: FreeFrame

Vendored as a git submodule at external/ffgl.

The plugin ABI itself. An FFGL effect or source is defined by this SDK's headers — there is no other way to be loadable by Resolume Arena and Avenue.

### GLEW — the OpenGL Extension Wrangler Library

<https://github.com/nigels-com/glew>  
Licence: BSD-3-Clause (with Mesa 3-D and Khronos components)  
Copyright: Milan Ikits, Marcelo E. Magallon and Lev Povalahev

Arrives inside the FFGL submodule at external/ffgl/deps/glew-2.1.0. Not fetched separately.

Resolves OpenGL entry points on Windows, where the system headers stop at OpenGL 1.1.

### zlib

<https://zlib.net>  
Licence: zlib  
Copyright: Jean-loup Gailly and Mark Adler

The system's copy, linked by the offline harness only, for its PNG writer. Not shipped in the bundle.

## Standards and published specifications

What the implementation is measured against.

- **ITU-R BT.709** — The OETF (the 0.45 exponent, the 0.018 break, and the 1.099 / 4.5 constants the harness checks the family reproduces), the luma weights, and the primaries the Standard matrix maps to.
- **SMPTE 170M / SMPTE RP 145 ("SMPTE-C")** — The standard-definition primaries the Standard matrix maps from; the resulting matrix is checked against the published one in Poynton, *Digital Video and HD*.
- **Melissa E. O'Neill, "PCG: A Family of Simple Fast Space-Efficient Statistically Good Algorithms for Random Number Generation" (Harvey Mudd College, 2014)** — The integer output permutation used for the drift's noise, implemented from the paper.

## Reference

Nothing was copied from these; they are what the model was built from.

### Broadcast camera processing

The order of a camera's processing chain and the names of its controls — master gain and black, white balance, the linear matrix, detail (aperture correction) with its crispening, coring, level dependence and skin detail, the knee, gamma and black gamma, white clip — are the standard account in broadcast engineering texts and in any CCU's operating manual. Implemented from that description; no manufacturer's table, curve or code was used, and the matrix presets carry generic names for that reason.

## Getting this wrong

If your work is here and the description is inaccurate, the licence is wrong, or you would rather not be listed — open an issue and it will be fixed.
