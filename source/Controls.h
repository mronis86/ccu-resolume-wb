#pragma once

/**
	Every 0..1 host parameter to the unit the CCU labels it in.

	`SetParamInfo` clamps an FF_TYPE_STANDARD default into 0..1 before
	`SetParamRange` can widen it (SDK b1afaf9), so every slider here is 0..1
	and the conversion lives in one place. The harness restates each law from
	the comment beside it and holds this file to it (`cctest --laws`).

	Several laws are written as `null + scale * ( p - p0 )` rather than
	`lo + ( hi - lo ) p`, and that is not style. A check depends on a specific
	slider position landing on a specific value EXACTLY in binary: 0 dB at
	Master Gain 0.25, a zero pedestal at Master Black 0.25, unity white clip
	at 0.5, unit saturation at 0.5, and so on. `( p - p0 )` is exactly zero
	at p0, `scale * 0` is exactly zero, and `null + 0` is the null. The other
	form has no slider position that lands on 1.0 exactly, and pow( L, 0.99999 )
	is not the identity.
*/

namespace ccu::controls
{

//--- Exposure --------------------------------------------------------------

/// Head-end gain in dB: 24 ( p - 0.25 ), so -6 .. +18 dB, 0 dB at 0.25.
double MasterGainDb( float p );
/// The gain itself, 10^( dB / 20 ). Exactly 1 at 0 dB.
double MasterGain( float p );

/// Pedestal, added on video: 0.2 ( p - 0.25 ), so -0.05 .. +0.15, 0 at 0.25.
double MasterBlack( float p );

/// The video level nothing exceeds: 1 + 0.3 ( p - 0.5 ), so 0.85 .. 1.15, 1 at 0.5.
double WhiteClip( float p );

//--- White -----------------------------------------------------------------

/// R Gain and B Gain, in dB: 12 ( p - 0.5 ), so +-6 dB, 0 at 0.5.
double ChannelGainDb( float p );
/// The gain itself. Exactly 1 at 0 dB.
double ChannelGain( float p );

/// The drift's RMS excursion in mireds: 60 p.
double DriftMireds( float p );

//--- Matrix ----------------------------------------------------------------

/// The saturation matrix's s: 2 p, so 0 .. 2, exactly 1 at 0.5.
double Saturation( float p );

//--- Detail ----------------------------------------------------------------

/// The gain on the detail signal: 3 p.
double DetailLevel( float p );

/// The kernel's spacing in pixels: 1 + 8 p, so 1 .. 9. Whole at p = k / 8.
double DetailSpacing( float p );

/// The H and V weights from one control: H = min( 1, 2 p ), V = min( 1, 2 ( 1 - p ) ).
/// Both exactly 1 at 0.5; 0 is vertical only, 1 horizontal only.
double DetailHorizontalWeight( float p );
double DetailVerticalWeight( float p );

/// Coring, in units of edge height: 0.25 p^2. An edge lower than this in
/// linear light produces no detail at all. Exactly 0 at the null.
double CoringEdge( float p );

/// Level dependence, 0 .. 1: how far detail is reduced toward zero luma.
double LevelDependence( float p );

/// Skin detail, 0 .. 1: the detail gain inside the skin window is 1 - this.
double SkinDetail( float p );

/// The window's centre, in degrees of hue: 360 p.
double SkinHueDegrees( float p );

/// The window's half-width, in degrees: 5 + 55 p, so 5 .. 60.
double SkinWidthDegrees( float p );

//--- Knee ------------------------------------------------------------------

/// The knee point, in linear light: 0.4 + 0.6 p, so 0.4 .. 1.0.
double KneePoint( float p );

/// The slope above it: 1 - 0.95 ( 1 - p ), so 0.05 .. 1, exactly 1 at 1.
double KneeSlope( float p );

//--- Gamma -----------------------------------------------------------------

/// The OETF's exponent: 0.45 + 0.2 ( p - 0.5 ), so 0.35 .. 0.55, 0.45 at 0.5.
double GammaExponent( float p );

/// Black gamma, 0 .. 1.
double BlackGamma( float p );

//--- Output ----------------------------------------------------------------

double Mix( float p );

} // namespace ccu::controls

namespace ccu::controls
{
/// Color Temperature in Kelvin: maps 0..1 to 2000K..10000K, null at 0.5 = 5600K.
double ColorTempKelvin( float p );
/// R and B gains from a color temperature in Kelvin, relative to 5600K.
void ColorTempGains( double kelvin, double& gainR, double& gainB );
/// Tint trim: magenta-green, null at 0.5 = 1.0 gain on G.
double TintGain( float p );
}
