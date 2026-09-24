/**
 * CCU — browser demo.
 *
 * A broadcast camera's processing chain with every knob out. The one idea,
 * from `source/Model.h`: the "video" look of a studio or OB camera is not a
 * filter but a processing chain in a fixed order, in linear light — linearise,
 * master gain, white balance (with a slow drift), matrix, detail (aperture
 * correction from pixel and line delays, cored, level-dependent, suppressed in
 * a skin window), knee, gamma, black gamma, pedestal, white clip, mix — and
 * the badly set-up camera looks fall out of the order rather than being drawn.
 *
 * The plugin is TWO passes. The linear pass builds the linear picture through
 * the matrix into an RGBA32F buffer with the luma in alpha; the process pass
 * reads it back with texelFetch, adds the detail and runs the rest of the
 * chain into the host's framebuffer. So this page is:
 *
 *   The plugin's shaders, unedited. `VERTEX`, `LINEAR` and `PROCESS` below are
 *   `kVertex`, `kLinear` and `kProcess` from `source/Shaders.cpp`, copied
 *   across character for character. `demo/tools/check_shaders.py` compares
 *   them and `tools/verify.sh` runs it.
 *
 *   A PORT of the CPU half. Everything the C++ computes on the way to a
 *   uniform is written out again here in JavaScript doubles: `Controls.cpp`
 *   function for function (every slider to its physical unit, the nulls
 *   exact); `Model.h`'s closed forms — the OETF's a and k from the exponent by
 *   continuity at the break, the 3x3 matrix per preset (Saturation, Rodrigues'
 *   hue rotation about grey, SMPTE 170M primaries to BT.709 primaries built
 *   from the chromaticities through PrimariesToXYZ and a 3x3 inverse), times
 *   the Saturation control; and the white-balance drift — the PCG hash, the
 *   Box-Muller normal and the Ornstein-Uhlenbeck step — driven by the page's
 *   clock. And `Ccu::ProcessOpenGL`'s two draws in their order with their
 *   uniforms. That much is a port, and nothing checks a port but a reader:
 *   `cctest` checks the C++ and the GLSL and has never heard of this page.
 *
 * ------------------------------------------------------------ the float buffer
 *
 * The linear picture is RGBA32F in the plugin (`PassBuffer::Ensure( W, H,
 * GL_RGBA32F, Nearest )`), and WebGL2 can only render into a float target
 * through EXT_color_buffer_float, so the page asks the kit for it
 * (`needFloat`) and refuses to start without it rather than dropping to eight
 * bits. An 8-bit intermediate would not "look a bit worse": the whole chain
 * runs in linear light, where the bottom of an 8-bit code is a step the
 * detail kernel and the knee would both see. The buffer is sampled NEAREST
 * and read with texelFetch, as in the plugin, so no float-filtering extension
 * is involved and nothing blends into it.
 *
 * ------------------------------------------------------------ the clock
 *
 * The plugin asks the host for time (`SetTimeSupported( true )`) and runs it
 * through clamp's `Clock` — unit voting on the host's SetTime, an origin and
 * offset in double, a delta believed unless backwards or over half a second,
 * in which case the clock steps on by one nominal frame. Here the clock is the
 * kit's: seconds accumulated from the page's frame deltas, clamped to 0.1 s a
 * frame, paused by Pause and stepped by Step. The drift's dt is the difference
 * between two of those, and a backwards step (Restart) is treated as the
 * plugin's jump: one nominal frame of 1/60 s. The frame counter that seeds the
 * walk's normal increments on every render, as the plugin's does on every
 * ProcessOpenGL; a redraw with the clock stopped (a slider moved while paused)
 * has dt = 0, and DriftStep returns the walk unchanged, as it does in the C++.
 *
 * ------------------------------------------------------------ what is missing
 *
 * **No face.** The generated clips carry no skin; the skin window acts on
 * whatever hue falls in it (the scene's warm sun and lamp do). **Nothing
 * audio**: CCU has no audio path. **The About block is absent**, as on every
 * page in this suite. The harness-only `Perturb` is held at 0, what the
 * shipped plugin carries, so the negative controls are not here.
 *
 * And what every page in this suite is not: this is the plugin's shaders and a
 * port of its CPU half, not the plugin. No Resolume, no composition, no FFGL,
 * and GLSL ES 3.00 in a browser rather than desktop GL 4.1 core.
 */

import { mountDemo } from './vendor/demo.js';
import { Program, PassBuffer, bindTexture } from './vendor/gl.js';

//---------------------------------------------------------------------------
// Shaders — verbatim from source/Shaders.cpp. Do not edit here.
//---------------------------------------------------------------------------

const VERTEX = `#version 410 core

layout( location = 0 ) in vec4 vPosition;
layout( location = 1 ) in vec2 vUV;

out vec2 uv;

void main()
{
	gl_Position = vPosition;
	//Straight through in 0..1 picture space. The host's MaxUV is applied
	//where the host's texture is read and nowhere else.
	uv = vUV;
}
`;

const LINEAR = `#version 410 core

in vec2 uv;
out vec4 fragColor;

uniform sampler2D InputTexture;
uniform vec2 MaxUV;

uniform float MasterGain;   //linear, exactly 1 at 0 dB
uniform float GainR;        //white balance, drift included
uniform float GainB;
uniform mat3 Matrix;        //Saturation . Preset, row-major on the CPU, transposed on upload

//The inverse OETF at the null exponent: V < Knee ? V / K : ( ( V + C ) / A )^( 1 / g ).
uniform float InvA;
uniform float InvC;         //A - 1
uniform float InvK;
uniform float InvKnee;      //K * 0.018, in video
uniform float InvGamma;     //1 / 0.45

//Only the negative controls read these: with KneeFirst the knee runs here,
//before white balance and the matrix, and the process pass skips it.
uniform int Perturb;
uniform int KneeOn;
uniform float KneePoint;
uniform float KneeSlope;

const vec3 kLuma = vec3( 0.2126, 0.7152, 0.0722 );

float linearise( float v )
{
	//Perturb 1: a plain 2.2 power in place of the inverse OETF -- the
	//rest of the chain then runs in the wrong space (a negative control).
	if( ( Perturb & 1 ) != 0 )
		return pow( v, 2.2 );
	return v < InvKnee ? v / InvK : pow( ( v + InvC ) / InvA, InvGamma );
}

float knee( float c )
{
	return c > KneePoint ? KneePoint + ( c - KneePoint ) * KneeSlope : c;
}

void main()
{
	vec4 src = texture( InputTexture, uv * MaxUV );
	vec3 v   = max( src.rgb, vec3( 0.0 ) );

	//The clip stands in for scene light: linearise, then head-end gain.
	vec3 lin = vec3( linearise( v.r ), linearise( v.g ), linearise( v.b ) ) * MasterGain;

	//Perturb 2: the knee before white balance (a negative control). The
	//order is the whole point of --order: a warm white through WB then the
	//knee compresses in R; through the knee then WB it clips in R.
	if( ( Perturb & 2 ) != 0 && KneeOn != 0 )
		lin = vec3( knee( lin.r ), knee( lin.g ), knee( lin.b ) );

	//White balance: R and B gains about G.
	lin = vec3( lin.r * GainR, lin.g, lin.b * GainB );

	//The matrix, in linear light.
	lin = Matrix * lin;

	fragColor = vec4( lin, dot( lin, kLuma ) );
}
`;

const PROCESS = `#version 410 core

in vec2 uv;
out vec4 fragColor;

uniform sampler2D LinearTexture;//rgb linear after the matrix, a = luma
uniform sampler2D InputTexture; //the host's picture: alpha and the mix
uniform vec2 MaxUV;
uniform int PictureW;
uniform int PictureH;

//Detail
uniform float DetailLevel;
uniform int SpacingInt;         //s = SpacingInt + SpacingFrac
uniform float SpacingFrac;
uniform float HWeight;
uniform float VWeight;
uniform float CoringDead;       //the dead zone on the detail signal: Coring / 4
uniform float LevelDep;
uniform float LevelRef;
uniform float SkinSuppress;     //the Skin Detail control; the gain inside the window is 1 - this
uniform float SkinHue;          //degrees
uniform float SkinWidth;        //degrees, half-width
uniform float SkinInner;        //the flat part of the window, as a fraction of the width
uniform float SkinChromaLo;
uniform float SkinChromaHi;

//Knee, in linear light, per channel
uniform int KneeOn;
uniform float KneePoint;
uniform float KneeSlope;

//The OETF at the control's exponent: L < Break ? K L : A L^g - C
uniform float OetfA;
uniform float OetfC;            //A - 1
uniform float OetfK;
uniform float OetfBreak;
uniform float OetfGamma;

//Black gamma, pedestal, clip
uniform float BlackGamma;
uniform float BlackLevel;
uniform float BlackLift;
uniform float Pedestal;
uniform float WhiteClip;

uniform float MixAmount;
uniform int ShowDetail;
uniform int Perturb;

//Clamped to the picture: texelFetch outside the texture is undefined, and
//the edge pixel's neighbour past the edge is the edge pixel itself.
float lumaAt( int x, int y )
{
	return texelFetch( LinearTexture, ivec2( clamp( x, 0, PictureW - 1 ), clamp( y, 0, PictureH - 1 ) ), 0 ).a;
}

//The ( -1/4, 1/2, -1/4 ) kernel at a spacing of SpacingInt + SpacingFrac
//along ( dx, dy ), each far tap the lerp of the two texels either side.
//At a whole spacing the lerp is ( 1 - 0 ) a + 0 b, which is a exactly.
float highpass( int x, int y, int dx, int dy, float centre )
{
	int i   = SpacingInt;
	float f = SpacingFrac;
	float before = ( 1.0 - f ) * lumaAt( x - i * dx, y - i * dy ) + f * lumaAt( x - ( i + 1 ) * dx, y - ( i + 1 ) * dy );
	float after  = ( 1.0 - f ) * lumaAt( x + i * dx, y + i * dy ) + f * lumaAt( x + ( i + 1 ) * dx, y + ( i + 1 ) * dy );
	return 0.5 * centre - 0.25 * ( before + after );
}

float hueDegrees( vec3 c )
{
	float h = degrees( atan( 1.7320508075688772 * ( c.g - c.b ), 2.0 * c.r - c.g - c.b ) );
	return h < 0.0 ? h + 360.0 : h;
}

float knee( float c )
{
	return c > KneePoint ? KneePoint + ( c - KneePoint ) * KneeSlope : c;
}

float encode( float l )
{
	l = max( l, 0.0 );
	return l < OetfBreak ? OetfK * l : OetfA * pow( l, OetfGamma ) - OetfC;
}

float blackGamma( float v )
{
	if( v < BlackLevel )
	{
		float u = v / BlackLevel;
		v += BlackGamma * BlackLift * BlackLevel * u * ( 1.0 - u ) * ( 1.0 - u );
	}
	return v;
}

void main()
{
	ivec2 p   = ivec2( gl_FragCoord.xy );
	vec4 here = texelFetch( LinearTexture, p, 0 );
	vec3 lin  = here.rgb;
	float Y   = here.a;
	vec4 src  = texture( InputTexture, uv * MaxUV );

	//--- detail ---------------------------------------------------------
	float d = HWeight * highpass( p.x, p.y, 1, 0, Y ) + VWeight * highpass( p.x, p.y, 0, 1, Y );

	//Perturb 8: the kernel doubled (a negative control).
	if( ( Perturb & 8 ) != 0 )
		d *= 2.0;

	//Coring: a dead zone. Small detail is not boosted at all. Perturb 4
	//removes it (a negative control).
	if( ( Perturb & 4 ) == 0 )
		d = sign( d ) * max( abs( d ) - CoringDead, 0.0 );

	//Level dependence: less detail where the luma is low.
	float levelGain = 1.0 - LevelDep * ( 1.0 - min( 1.0, Y / LevelRef ) );

	//Skin detail: less detail inside a hue window, gated on chroma so a
	//neutral is never skin. Flat 1 inside SkinInner * SkinWidth, 0 outside
	//SkinWidth: smoothstep clamps exactly at both edges.
	float dh     = abs( mod( hueDegrees( lin ) - SkinHue + 540.0, 360.0 ) - 180.0 );
	float window = 1.0 - smoothstep( SkinInner * SkinWidth, SkinWidth, dh );
	float hi     = max( lin.r, max( lin.g, lin.b ) );
	float chroma = hi > 0.0 ? ( hi - min( lin.r, min( lin.g, lin.b ) ) ) / hi : 0.0;
	window *= smoothstep( SkinChromaLo, SkinChromaHi, chroma );
	float skinGain = 1.0 - SkinSuppress * window;
	//Perturb 32: the window ignored (a negative control).
	if( ( Perturb & 32 ) != 0 )
		skinGain = 1.0;

	float D = DetailLevel * d * levelGain * skinGain;
	lin += vec3( D );

	//--- knee, per channel, in linear light -----------------------------
	//Perturb 2 ran it in the linear pass instead (a negative control).
	if( KneeOn != 0 && ( Perturb & 2 ) == 0 )
		lin = vec3( knee( lin.r ), knee( lin.g ), knee( lin.b ) );

	//--- gamma ----------------------------------------------------------
	vec3 v = vec3( encode( lin.r ), encode( lin.g ), encode( lin.b ) );

	//--- black gamma, pedestal, white clip ------------------------------
	v = vec3( blackGamma( v.r ), blackGamma( v.g ), blackGamma( v.b ) );
	v += vec3( Pedestal );
	v = max( min( v, vec3( WhiteClip ) ), vec3( 0.0 ) );

	if( ShowDetail != 0 )
		v = vec3( 0.5 + D );

	//The mix written out: at MixAmount = 1 this is v * 1 + src * 0, which
	//is exactly v. mix() may be evaluated as src + ( v - src ) * a, which
	//is not (GLSL 4.10 8.3 promises the form, not the rounding).
	vec3 result = v * MixAmount + src.rgb * ( 1.0 - MixAmount );
	fragColor   = vec4( result, src.a );
}
`;

//===========================================================================
// Model.h, ported. The constants, the option table, and the closed forms the
// plugin computes on the CPU in double: the OETF family, the matrices and
// their derivations, the drift's step. JavaScript numbers are IEEE doubles,
// so the arithmetic is the same width as the C++'s; pow, exp, log, cos and
// sqrt are the engine's rather than libm's, and may differ in the last bit.
//===========================================================================

const K_PI = 3.14159265358979323846;

const K_LUMA_R = 0.2126;
const K_LUMA_G = 0.7152;
const K_LUMA_B = 0.0722;

//--- the OETF -------------------------------------------------------------
//
// Given the exponent g and the break b, the linear and power segments meet in
// value AND slope only for a( g ) = 1 / ( 1 - ( 1 - g ) b^g ) and
// k( g ) = a g b^( g - 1 ). The Gamma control sets g; a and k follow, once a
// frame. The linearise uses the same family at exactly 0.45.
const K_OETF_BREAK = 0.018;
const K_OETF_EXPONENT_NULL = 0.45;

function oetfFor(gamma) {
  const bg = Math.pow(K_OETF_BREAK, gamma);
  const a = 1.0 / (1.0 - (1.0 - gamma) * bg);
  const k = a * gamma * Math.pow(K_OETF_BREAK, gamma - 1.0);
  return { gamma, a, k, knee: k * K_OETF_BREAK };
}

//--- black gamma, detail, skin ---------------------------------------------
const K_BLACK_GAMMA_LEVEL = 0.25;
const K_BLACK_GAMMA_LIFT = 1.5;
const K_DETAIL_STEP_PEAK = 0.25;
const K_LEVEL_DEPENDENCE_REF = 0.2;
const K_SKIN_INNER_FRACTION = 0.75;
const K_SKIN_CHROMA_LOW = 0.05;
const K_SKIN_CHROMA_HIGH = 0.15;

//--- the matrices ----------------------------------------------------------
//
// Each preset is a derivation, not a typed-in table, and the names are
// generic: nothing here is a manufacturer's matrix.
const K_MATRIX_IDENTITY = 0;
const K_MATRIX_STANDARD = 1;
const K_MATRIX_HIGH_SATURATION = 2;
const K_MATRIX_FILM_LIKE = 3;
const K_MATRIX_NAMES = ['Identity', 'Standard', 'High Saturation', 'Film-like'];

const K_HIGH_SATURATION = 1.35;
const K_FILM_SATURATION = 0.82;
const K_FILM_HUE_DEGREES = 4.0;

/// Row-major, out_i = sum_j m[ i ][ j ] in_j, as Model.h's Mat3.
const mat3Identity = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function mat3Multiply(a, b) {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      for (let k = 0; k < 3; k += 1) r[i][j] += a[i][k] * b[k][j];
    }
  }
  return r;
}

function mat3Apply(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/// ( 1 - s ) P + s I, P the projection onto BT.709 luma. s = 1 is I exactly.
function saturationMatrix(s) {
  const w = [K_LUMA_R, K_LUMA_G, K_LUMA_B];
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) r[i][j] = (1.0 - s) * w[j] + s * (i === j ? 1.0 : 0.0);
  }
  return r;
}

/// Rodrigues' rotation about the grey axis ( 1, 1, 1 ) / sqrt 3.
function hueRotate(degrees) {
  const t = degrees * K_PI / 180.0;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const k = 1.0 / Math.sqrt(3.0);
  const kk = (1.0 - c) * k * k;
  const sk = s * k;
  return [
    [c + kk, kk - sk, kk + sk],
    [kk + sk, c + kk, kk - sk],
    [kk - sk, kk + sk, c + kk],
  ];
}

function mat3Inverse(m) {
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  return [
    [
      (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det,
      (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det,
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det,
    ],
    [
      (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det,
      (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det,
    ],
    [
      (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det,
      (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det,
    ],
  ];
}

/// RGB -> XYZ for a set of primaries and a white, the white mapping to Y = 1.
function primariesToXYZ(xr, yr, xg, yg, xb, yb, xw, yw) {
  const p = [[xr, xg, xb], [yr, yg, yb], [1.0 - xr - yr, 1.0 - xg - yg, 1.0 - xb - yb]];
  const white = [xw / yw, 1.0, (1.0 - xw - yw) / yw];
  const s = mat3Apply(mat3Inverse(p), white);
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) r[i][j] = p[i][j] * s[j];
  }
  return r;
}

/// SMPTE 170M primaries -> BT.709 primaries. Both standards' white is D65.
function smpteCToRec709() {
  const c = primariesToXYZ(0.630, 0.340, 0.310, 0.595, 0.155, 0.070, 0.3127, 0.3290);
  const r709 = primariesToXYZ(0.640, 0.330, 0.300, 0.600, 0.150, 0.060, 0.3127, 0.3290);
  return mat3Multiply(mat3Inverse(r709), c);
}

function presetMatrix(preset) {
  switch (preset) {
    case K_MATRIX_STANDARD: return smpteCToRec709();
    case K_MATRIX_HIGH_SATURATION: return saturationMatrix(K_HIGH_SATURATION);
    case K_MATRIX_FILM_LIKE: return mat3Multiply(saturationMatrix(K_FILM_SATURATION), hueRotate(K_FILM_HUE_DEGREES));
    default: return mat3Identity();
  }
}

//--- the drift ------------------------------------------------------------
//
// An Ornstein-Uhlenbeck walk with unit stationary variance and a 20 s time
// constant, stepped once a frame from the frame's dt: u <- a u + sqrt( 1 -
// a^2 ) g, a = exp( -dt / tau ), g ~ N( 0, 1 ) from the fleet's integer hash
// of ( seed, frame ) through Box-Muller. The walk is scaled by the Drift
// control at use, so a slider move never jumps the state.
const K_DRIFT_TAU_SECONDS = 20.0;
const K_DRIFT_GAIN_PER_MIRED = 0.004;
const K_DRIFT_SEED = 0x43433031; // "CC01"

/// The PCG output hash on a uint32. Math.imul is the 32-bit multiply; every
/// intermediate is brought back to uint32 with >>> 0, which is the C++'s
/// unsigned wraparound.
function hashInt(v) {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/// A standard normal for frame n: Box-Muller on two hashed uniforms, the
/// first in ( 0, 1 ] so the log is finite.
function driftGaussian(frame) {
  const u1 = ((hashInt((K_DRIFT_SEED + 2 * frame) >>> 0) >>> 8) + 1.0) / 16777216.0;
  const u2 = (hashInt((K_DRIFT_SEED + 2 * frame + 1) >>> 0) >>> 8) / 16777216.0;
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * K_PI * u2);
}

function driftStep(u, dtSeconds, frame) {
  if (dtSeconds <= 0.0) return u;
  const a = Math.exp(-dtSeconds / K_DRIFT_TAU_SECONDS);
  return a * u + Math.sqrt(1.0 - a * a) * driftGaussian(frame);
}

/// An option's stored value as an index into its `count` elements, rounded
/// and clamped as Model.h's OptionIndex (lround; the value is never negative
/// here, where lround and Math.round agree).
function optionIndex(value, count) {
  const i = Math.round(value);
  return i < 0 ? 0 : (i >= count ? count - 1 : i);
}

/// Clock.h's kNominalFrameSeconds: what a jump advances the clock by.
const K_NOMINAL_FRAME_SECONDS = 1.0 / 60.0;

//===========================================================================
// Controls.cpp, ported. Every conversion from the host's 0..1 to the unit the
// CCU labels it in lives there and nowhere else, so it lives here and nowhere
// else too. Several laws are written `null + scale * ( p - p0 )` rather than
// `lo + ( hi - lo ) p`, and that is not style: ( p - p0 ) is exactly zero at
// p0, so 0 dB at Master Gain 0.25, unity white clip at 0.5 and the rest land
// EXACTLY in binary.
//===========================================================================

const unit = (p) => Math.min(1.0, Math.max(0.0, Number(p)));

//--- Exposure --------------------------------------------------------------
const masterGainDb = (p) => 24.0 * (unit(p) - 0.25);
const masterGain = (p) => Math.pow(10.0, masterGainDb(p) / 20.0);
const masterBlack = (p) => 0.2 * (unit(p) - 0.25);
const whiteClip = (p) => 1.0 + 0.3 * (unit(p) - 0.5);

//--- White -----------------------------------------------------------------
const channelGainDb = (p) => 12.0 * (unit(p) - 0.5);
const channelGain = (p) => Math.pow(10.0, channelGainDb(p) / 20.0);
const driftMireds = (p) => 60.0 * unit(p);

//--- Matrix ----------------------------------------------------------------
const saturation = (p) => 2.0 * unit(p);

//--- Detail ----------------------------------------------------------------
const detailLevel = (p) => 3.0 * unit(p);
const detailSpacing = (p) => 1.0 + 8.0 * unit(p);
const detailHorizontalWeight = (p) => Math.min(1.0, 2.0 * unit(p));
const detailVerticalWeight = (p) => Math.min(1.0, 2.0 * (1.0 - unit(p)));
function coringEdge(p) {
  const q = unit(p);
  return 0.25 * q * q;
}
const levelDependence = (p) => unit(p);
const skinDetail = (p) => unit(p);
const skinHueDegrees = (p) => 360.0 * unit(p);
const skinWidthDegrees = (p) => 5.0 + 55.0 * unit(p);

//--- Knee ------------------------------------------------------------------
const kneePoint = (p) => 0.4 + 0.6 * unit(p);
const kneeSlope = (p) => 1.0 - 0.95 * (1.0 - unit(p));

//--- Gamma -----------------------------------------------------------------
const gammaExponent = (p) => 0.45 + 0.2 * (unit(p) - 0.5);
const blackGamma = (p) => unit(p);

//--- Output ----------------------------------------------------------------
const mixAmount = (p) => unit(p);

//===========================================================================
// The renderer: Ccu::ProcessOpenGL, in its order.
//
//   clock + drift   in double, once a frame
//   the settings    every control through Controls.cpp; the OETF, the matrix
//   the buffer      the linear picture, RGBA32F at picture size, Nearest
//   1. linear       into that buffer
//   2. process      straight into the canvas, the host's framebuffer here
//===========================================================================

/// The C++'s `f( double )`: the cast to float on the way to a uniform.
const f = Math.fround;

/// What the line under the canvas reports. Filled by the renderer.
const telemetry = { frame: 0, walk: 0, mireds: 0, gainR: 1, gainB: 1, dt: 0 };

function createRenderer(gl, quad) {
  const linearShader = new Program(gl, VERTEX, LINEAR, 'linear');
  const processShader = new Program(gl, VERTEX, PROCESS, 'process');

  // PassBuffer::Ensure( W, H, GL_RGBA32F, Sampling::Nearest ), clamp to edge.
  const linear = new PassBuffer(gl, { filter: 'nearest' });

  // What InitGL resets: the clock's last reading, the walk, the frame counter.
  let lastNow = 0.0;
  let driftWalk = 0.0;
  let frameIndex = 0;

  // The harness-only hook, at what the shipped plugin carries.
  const PERTURB = 0;

  return {
    render({ input, params, width: vpW, height: vpH, time }) {
      const p = (id) => params.get(id);
      const picture = input;
      const W = picture.width;
      const H = picture.height;

      //------------------------------------------------------------------
      // The clock and the drift, in double. `time` is the kit's clock; a
      // backwards reading is the plugin's Clock's jump, one nominal frame.
      //------------------------------------------------------------------
      const now = time;
      const dt = now < lastNow ? K_NOMINAL_FRAME_SECONDS : Math.max(0.0, now - lastNow);
      lastNow = now;
      driftWalk = driftStep(driftWalk, dt, frameIndex);
      const thisFrame = frameIndex;
      frameIndex = (frameIndex + 1) >>> 0;

      //------------------------------------------------------------------
      // The settings, in physical units.
      //------------------------------------------------------------------
      const gain = masterGain(p('masterGain'));
      const pedestal = masterBlack(p('masterBlack'));
      const clip = whiteClip(p('whiteClip'));

      const shiftMired = driftMireds(p('drift')) * driftWalk;
      const gainR = channelGain(p('rGain')) * Math.exp(K_DRIFT_GAIN_PER_MIRED * shiftMired);
      const gainB = channelGain(p('bGain')) * Math.exp(-K_DRIFT_GAIN_PER_MIRED * shiftMired);

      const preset = optionIndex(p('matrix'), K_MATRIX_NAMES.length);
      const matrix = mat3Multiply(saturationMatrix(saturation(p('saturation'))), presetMatrix(preset));

      const level = detailLevel(p('detailLevel'));
      const spacing = detailSpacing(p('detailFreq'));
      const spacingInt = Math.floor(spacing);
      const spacingFrac = spacing - spacingInt;
      const hWeight = detailHorizontalWeight(p('hvRatio'));
      const vWeight = detailVerticalWeight(p('hvRatio'));
      const coringDead = coringEdge(p('coring')) * K_DETAIL_STEP_PEAK;
      const levelDep = levelDependence(p('levelDep'));
      const skin = skinDetail(p('skinDetail'));
      const skinHue = skinHueDegrees(p('skinHue'));
      const skinWidth = skinWidthDegrees(p('skinWidth'));

      const kneeOn = p('kneeOn') >= 0.5;
      const point = kneePoint(p('kneePoint'));
      const slope = kneeSlope(p('kneeSlope'));

      const exponent = gammaExponent(p('gamma'));
      const oetf = oetfFor(exponent);
      const inverse = oetfFor(K_OETF_EXPONENT_NULL);
      const black = blackGamma(p('blackGamma'));

      const showDetail = p('showDetail') >= 0.5;
      const mix = mixAmount(p('mix'));

      //------------------------------------------------------------------
      // The buffer. Allocated before anything binds.
      //------------------------------------------------------------------
      linear.ensure(W, H, gl.RGBA32F);

      // The host's MaxUV: the fraction of the texture the picture occupies.
      // The kit's clip textures are exactly the picture, so ( 1, 1 ).
      const maxU = 1.0;
      const maxV = 1.0;

      gl.disable(gl.BLEND);

      //------------------------------------------------------------------
      // 1. linear
      //------------------------------------------------------------------
      linear.bind();
      linearShader.use();
      bindTexture(gl, 0, picture.texture);
      linearShader.setSampler('InputTexture', 0);
      linearShader.set('MaxUV', maxU, maxV);
      linearShader.set('MasterGain', f(gain));
      linearShader.set('GainR', f(gainR));
      linearShader.set('GainB', f(gainB));
      {
        // The C++ hands glUniformMatrix3fv a row-major array with transpose
        // GL_TRUE. The same nine values go in here column-major with
        // transpose false: element ( i, j ) lands in the same slot.
        const m = new Float32Array(9);
        for (let i = 0; i < 3; i += 1) {
          for (let j = 0; j < 3; j += 1) m[j * 3 + i] = f(matrix[i][j]);
        }
        gl.uniformMatrix3fv(linearShader.location('Matrix'), false, m);
      }
      linearShader.set('InvA', f(inverse.a));
      linearShader.set('InvC', f(inverse.a - 1.0));
      linearShader.set('InvK', f(inverse.k));
      linearShader.set('InvKnee', f(inverse.knee));
      linearShader.set('InvGamma', f(1.0 / inverse.gamma));
      linearShader.setInt('Perturb', PERTURB);
      linearShader.setInt('KneeOn', kneeOn ? 1 : 0);
      linearShader.set('KneePoint', f(point));
      linearShader.set('KneeSlope', f(slope));
      quad.draw();

      //------------------------------------------------------------------
      // 2. process, straight into the canvas. The host's viewport is the
      //    whole canvas here.
      //------------------------------------------------------------------
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, vpW, vpH);

      processShader.use();
      bindTexture(gl, 0, linear.texture);
      bindTexture(gl, 1, picture.texture);
      processShader.setSampler('LinearTexture', 0);
      processShader.setSampler('InputTexture', 1);
      processShader.set('MaxUV', maxU, maxV);
      processShader.setInt('PictureW', W);
      processShader.setInt('PictureH', H);

      processShader.set('DetailLevel', f(level));
      processShader.setInt('SpacingInt', spacingInt);
      processShader.set('SpacingFrac', f(spacingFrac));
      processShader.set('HWeight', f(hWeight));
      processShader.set('VWeight', f(vWeight));
      processShader.set('CoringDead', f(coringDead));
      processShader.set('LevelDep', f(levelDep));
      processShader.set('LevelRef', f(K_LEVEL_DEPENDENCE_REF));
      processShader.set('SkinSuppress', f(skin));
      processShader.set('SkinHue', f(skinHue));
      processShader.set('SkinWidth', f(skinWidth));
      processShader.set('SkinInner', f(K_SKIN_INNER_FRACTION));
      processShader.set('SkinChromaLo', f(K_SKIN_CHROMA_LOW));
      processShader.set('SkinChromaHi', f(K_SKIN_CHROMA_HIGH));

      processShader.setInt('KneeOn', kneeOn ? 1 : 0);
      processShader.set('KneePoint', f(point));
      processShader.set('KneeSlope', f(slope));

      processShader.set('OetfA', f(oetf.a));
      processShader.set('OetfC', f(oetf.a - 1.0));
      processShader.set('OetfK', f(oetf.k));
      processShader.set('OetfBreak', f(K_OETF_BREAK));
      processShader.set('OetfGamma', f(oetf.gamma));

      processShader.set('BlackGamma', f(black));
      processShader.set('BlackLevel', f(K_BLACK_GAMMA_LEVEL));
      processShader.set('BlackLift', f(K_BLACK_GAMMA_LIFT));
      processShader.set('Pedestal', f(pedestal));
      processShader.set('WhiteClip', f(clip));

      processShader.set('MixAmount', f(mix));
      processShader.setInt('ShowDetail', showDetail ? 1 : 0);
      processShader.setInt('Perturb', PERTURB);
      quad.draw();

      // Leave nothing bound that a framebuffer will be written through next
      // frame; the kit's source pass only uses unit 0.
      bindTexture(gl, 1, null);
      bindTexture(gl, 0, null);
      gl.activeTexture(gl.TEXTURE0);

      telemetry.frame = thisFrame;
      telemetry.walk = driftWalk;
      telemetry.mireds = shiftMired;
      telemetry.gainR = gainR;
      telemetry.gainB = gainB;
      telemetry.dt = dt;
    },
  };
}

//===========================================================================
// The controls, read out of Ccu::Ccu(). Same names, same groups, same order,
// same defaults, same dropdown elements. Absent: the About block.
//===========================================================================

const std = (id, name, def, group, extra = {}) => ({ id, name, type: 'standard', default: def, group, ...extra });
const opt = (id, name, elements, def, group, hint) => ({ id, name, type: 'option', elements, default: def, group, hint });
const bool = (id, name, def, group, hint) => ({ id, name, type: 'boolean', default: def, group, hint });

const signed = (v, digits) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(digits)}`;
const dbText = (db) => `${signed(db, 1)} dB`;
const degText = (d) => `${d.toFixed(1)}°`;

const demo = mountDemo({
  name: 'CCU',
  pluginId: 'CC01',
  tagline:
    'A broadcast camera’s processing chain with every knob out. Not a filter: the stages of a studio or OB camera in their fixed order, in linear light — white balance, matrix, detail (aperture correction), knee, gamma and black gamma, pedestal, white clip — each labelled the way a camera control unit labels it. The badly set-up camera looks fall out: halos the width of the detail delay, grain sharpened by a low coring, skies that keep colour through the knee, a warm white that clips in one channel first, and a white balance that drifts as the camera warms up. The two passes here are the plugin’s own shaders; the constants they read are a port of its C++.',
  repo: 'https://github.com/stoatworks-labs/ccu',

  // The plugin registers as FF_EFFECT.
  kind: 'effect',

  // The linear picture is RGBA32F, as in the plugin: the whole chain runs in
  // linear light and an 8-bit intermediate would be seen by the detail kernel
  // and the knee alike.
  needFloat: true,

  params: [
    std('masterGain', 'Master Gain', 0.25, 'Exposure', {
      display: (v) => dbText(masterGainDb(v)),
      hint: 'Head-end gain in dB, 24( p − 0.25 ): −6 to +18 dB, exactly 0 dB at a quarter. Applied in linear light before white balance, so a gained-up highlight is what the knee catches.',
    }),
    std('masterBlack', 'Master Black', 0.25, 'Exposure', {
      display: (v) => `${signed(masterBlack(v), 3)} video`,
      hint: 'The pedestal, added on video after gamma: 0.2( p − 0.25 ), −0.05 to +0.15, exactly 0 at a quarter.',
    }),
    std('whiteClip', 'White Clip', 0.5, 'Exposure', {
      display: (v) => `${whiteClip(v).toFixed(3)} video`,
      hint: 'The video level nothing exceeds: 1 + 0.3( p − 0.5 ), 0.85 to 1.15, exactly 1 at the middle.',
    }),

    std('rGain', 'R Gain', 0.5, 'White', {
      display: (v) => dbText(channelGainDb(v)),
      hint: 'Red gain about green, 12( p − 0.5 ): ±6 dB, exactly 0 dB at the middle. In linear light, before the matrix.',
    }),
    std('bGain', 'B Gain', 0.5, 'White', {
      display: (v) => dbText(channelGainDb(v)),
      hint: 'Blue gain about green, the same law.',
    }),
    std('drift', 'Drift', 0.15, 'White', {
      display: (v) => (unit(v) <= 0 ? 'none' : `${driftMireds(v).toFixed(1)} mireds RMS`),
      hint: 'A slow random walk of the white balance in mireds: an Ornstein–Uhlenbeck walk with a 20 s time constant, 60 p mireds RMS, moving the R and B gains by e^(±0.004 × mireds). Exactly nothing at 0.',
    }),

    opt('matrix', 'Matrix', K_MATRIX_NAMES, K_MATRIX_STANDARD, 'Matrix',
      'A 3×3 in linear light. Identity; Standard (SMPTE 170M primaries to BT.709 primaries, from the chromaticities); High Saturation (1.35); Film-like (Saturation 0.82 with a 4° hue rotation about grey). Enum order, not alphabetical. Generic names: none is a manufacturer’s table.'),
    std('saturation', 'Saturation', 0.5, 'Matrix', {
      display: (v) => `× ${saturation(v).toFixed(2)}`,
      hint: 'Composed on top of the preset: ( 1 − s )P + sI about BT.709 luma, s = 2p, 0 to 2, exactly the identity at the middle.',
    }),

    std('detailLevel', 'Detail Level', 0.3, 'Detail', {
      display: (v) => `× ${detailLevel(v).toFixed(2)}`,
      hint: 'The gain on the detail signal, 3p. A step of height h overshoots by Level × h / 4 for exactly the delay, on each side.',
    }),
    std('detailFreq', 'Crispening Freq', 0.125, 'Detail', {
      display: (v) => `${detailSpacing(v).toFixed(2)} px delay`,
      hint: 'The kernel’s spacing in pixels, 1 + 8p: 1 to 9, whole at every eighth of the slider. A fractional spacing lerps between texels, by hand from two texelFetches. The halo is the width of the delay, not of the edge.',
    }),
    std('hvRatio', 'H/V Ratio', 0.5, 'Detail', {
      display: (v) => `H ${detailHorizontalWeight(v).toFixed(2)} · V ${detailVerticalWeight(v).toFixed(2)}`,
      hint: 'One control for both: H = min( 1, 2p ), V = min( 1, 2( 1 − p ) ). Vertical only at 0, horizontal only at 1, both exactly 1 at the middle.',
    }),
    std('coring', 'Coring', 0.3, 'Detail', {
      display: (v) => `edge ${coringEdge(v).toFixed(4)} linear`,
      hint: 'A dead zone in units of edge height, 0.25p²: an edge lower than this in linear light gets no detail at all. A low coring sharpens the grain; a high one plastic-coats the picture.',
    }),
    std('levelDep', 'Level Dependence', 0.5, 'Detail', {
      display: (v) => levelDependence(v).toFixed(2),
      hint: 'How far detail is reduced toward zero luma: gain = 1 − LD( 1 − min( 1, Y / 0.2 ) ).',
    }),
    std('skinDetail', 'Skin Detail', 0.4, 'Detail', {
      display: (v) => `gain ${(1 - skinDetail(v)).toFixed(2)} in window`,
      hint: 'The detail gain inside the skin window is 1 − this. The generated clips carry no face: the window acts on whatever hue falls in it.',
    }),
    std('skinHue', 'Skin Hue', 0.0556, 'Detail', {
      display: (v) => degText(skinHueDegrees(v)),
      hint: 'The window’s centre, 360p degrees of the linear colour’s hue: 0 at red, 60 at yellow. Skin is about 16°. Both ends are the same hue.',
    }),
    std('skinWidth', 'Skin Width', 0.2727, 'Detail', {
      display: (v) => `± ${degText(skinWidthDegrees(v))}`,
      hint: 'The window’s half-width, 5 + 55p degrees: flat inside three quarters of it, smoothstepped to the edge, and gated on chroma from 0.05 to 0.15 so a neutral is never skin.',
    }),

    bool('kneeOn', 'Knee On', 1, 'Knee',
      'Above the knee point a gentler slope, continuous at the point, per channel, in linear light — after white balance, so a warm white compresses in red rather than clipping. Off, it clips in red first.'),
    std('kneePoint', 'Knee Point', 0.5, 'Knee', {
      display: (v) => `${kneePoint(v).toFixed(3)} linear`,
      hint: 'The point in linear light, 0.4 + 0.6p: 0.4 to 1.0.',
    }),
    std('kneeSlope', 'Knee Slope', 0.25, 'Knee', {
      display: (v) => kneeSlope(v).toFixed(3),
      hint: 'The slope above the point, 1 − 0.95( 1 − p ): 0.05 to 1, exactly 1 at the top (no knee).',
    }),

    std('gamma', 'Gamma', 0.5, 'Gamma', {
      display: (v) => {
        const o = oetfFor(gammaExponent(v));
        return `γ ${o.gamma.toFixed(3)} · a ${o.a.toFixed(4)} · k ${o.k.toFixed(3)}`;
      },
      hint: 'The OETF’s exponent, 0.45 + 0.2( p − 0.5 ): 0.35 to 0.55, BT.709’s 0.45 at the middle. a and k follow from it by continuity at 0.018 and are shown as the port computes them; at 0.45 they are the standard’s 1.099 / 4.5 to its printed precision.',
    }),
    std('blackGamma', 'Black Gamma', 0.2, 'Gamma', {
      display: (v) => blackGamma(v).toFixed(2),
      hint: 'A lift of the video below 0.25, V + BG × 1.5 × 0.25 × u( 1 − u )², zero at and above the level with zero slope there.',
    }),

    std('mix', 'Mix', 1.0, 'Output', {
      hint: 'Written out as v × Mix + src × ( 1 − Mix ), so Mix = 1 is exactly the chain.',
    }),
    bool('showDetail', 'Show Detail', 0, 'Output',
      'The detail signal about mid grey instead of the picture, for setting up.'),
  ],

  // The scene leads: a moving picture with a full contrast range, a hot sun
  // for the knee, hard edges for the detail, and warm colours the skin window
  // can find. Bars and the ramps read the knee and the OETF as numbers.
  sources: ['scene', 'bars', 'bars100', 'ramp', 'grid', 'detail', 'spot'],

  // The plugin ships no factory presets. These are the page's own, expressed
  // entirely in the plugin's parameters and reachable with the controls.
  presets: {
    'Hot detail, low coring': { detailLevel: 0.6, detailFreq: 0.25, coring: 0.1 },
    'Knee off: a warm white clips': { kneeOn: 0, rGain: 0.75, masterGain: 0.4 },
    'Skin window off': { skinDetail: 0 },
    'Film-like matrix': { matrix: K_MATRIX_FILM_LIKE, gamma: 0.6, blackGamma: 0.5 },
    'Drifting hard': { drift: 1.0 },
    'Show Detail': { showDetail: 1 },
    'Chain at its nulls': { drift: 0, matrix: K_MATRIX_IDENTITY, detailLevel: 0, kneeOn: 0, blackGamma: 0 },
  },

  differences: [
    'The shaders are the plugin’s. The vertex shader and the two fragment passes are the plugin’s own GLSL, and demo/tools/check_shaders.py fails the repository’s verify script if a character of any of the three drifts from source/Shaders.cpp.',
    'The CPU half is a PORT, checked by nothing but a reader. Everything the C++ computes on the way to a uniform is written out again in JavaScript doubles: Controls.cpp function for function; Model.h’s OETF family (a and k from the exponent by continuity at the break, once a frame, and the inverse at exactly 0.45), the matrices as derivations (Saturation, Rodrigues’ hue rotation about grey, SMPTE 170M to BT.709 primaries from the chromaticities through a 3×3 inverse) times the Saturation control, the drift’s PCG hash, Box–Muller normal and Ornstein–Uhlenbeck step; and Ccu::ProcessOpenGL’s two draws with their uniforms. Doubles are the same width on both sides, but pow, exp, log, cos and sqrt are the JavaScript engine’s rather than libm’s and may differ in the last bit. cctest proves the C++ and the GLSL and has never heard of this page.',
    'The clock is the kit’s, not the plugin’s. The plugin votes on the unit of the host’s SetTime and keeps an origin and offset in double, believing a delta unless it is backwards or over half a second. Here the clock is seconds accumulated from the page’s frame deltas, clamped to 0.1 s a frame, paused by Pause and stepped by Step; the drift’s dt is the difference of two readings, and a backwards reading (Restart) is treated as the plugin’s jump, one nominal frame of 1/60 s. The frame counter that seeds the walk increments on every render, as the plugin’s does on every ProcessOpenGL. The walk starts at zero when the page starts, as it does at InitGL, and with the plugin’s own seed, so a reload replays the same walk.',
    'A float render target is required. The linear picture is RGBA32F in the plugin and WebGL2 can only render into one through EXT_color_buffer_float, so this page refuses to start without it rather than falling back to 8 bits, where the chain would run on quantised linear light. The buffer is sampled NEAREST with texelFetch as in the plugin; nothing filters or blends a float here.',
    'The host’s texture is the picture here. The plugin scales its reads of the host’s texture by MaxUV, the fraction a padded texture’s picture occupies; the kit’s clip textures are never padded, so MaxUV is ( 1, 1 ). And the host’s viewport, into which the process pass draws, is the whole canvas at the composition size, which is also the clip’s size — the process pass’s texelFetch at gl_FragCoord assumes exactly that, as it does in a host whose viewport matches its input.',
    'The 3×3 goes to the GPU column-major with transpose false, where the C++ hands glUniformMatrix3fv a row-major array with GL_TRUE. Same nine numbers in the same slots.',
    'The clips are 8-bit textures, as a clip in a host would be, and they carry no face: the skin window acts on whatever hue falls inside it — the scene’s warm sun and lamp do. There is no audio caveat: CCU has no audio path. The About block is absent, as on every page in this suite.',
    'The harness-only Perturb uniform is held at 0, what the shipped plugin carries. The seven negative controls cctest drives through it — the chain in gamma space, the knee before white balance, no coring, a doubled kernel, a steeper knee, the skin window ignored, the exponent high — are not on this page.',
    'The plugin’s numerical proof — every stage at its null returning the input within a bound derived from the OETF round trip in float, a step overshooting by exactly Level × h / 4 for exactly the delay, the knee’s slope and continuity, the OETF at three exponents, WB-then-knee against knee-then-WB, the skin window’s gain — is an offline harness in the repository. Nothing on this page measures anything.',
  ],

  createRenderer,
});

//---------------------------------------------------------------------------
// The line under the canvas: the drift as the port is running it. Skipped in
// embed mode.
//---------------------------------------------------------------------------
if (demo && !new URLSearchParams(window.location.search).has('embed')) {
  const stage = document.querySelector('.stage');
  if (stage) {
    const line = document.createElement('p');
    line.className = 'stage__status';
    stage.append(line);
    setInterval(() => {
      const { frame, walk, mireds, gainR, gainB } = telemetry;
      line.textContent =
        `Drift walk ${walk.toFixed(3)} (unit variance, τ 20 s) → ${signed(mireds, 1)} mireds: `
        + `R gain × ${gainR.toFixed(4)}, B gain × ${gainB.toFixed(4)}, stepped at frame ${frame.toLocaleString('en-GB')}. `
        + 'Ported from Model.h and stepped in this page; the plugin steps the same walk from the host’s clock.';
    }, 250);
  }
}
