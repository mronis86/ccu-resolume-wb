#include "Controls.h"

#include <algorithm>
#include <cmath>

namespace ccu::controls
{
namespace
{
double unit( float p )
{
	return std::clamp( static_cast< double >( p ), 0.0, 1.0 );
}
} // namespace

//--- Exposure --------------------------------------------------------------
double MasterGainDb( float p )
{
	return 24.0 * ( unit( p ) - 0.25 );
}
double MasterGain( float p )
{
	//pow( 10, 0 ) is exactly 1 in IEEE-754: the identity check rests on it.
	return std::pow( 10.0, MasterGainDb( p ) / 20.0 );
}
double MasterBlack( float p )
{
	return 0.2 * ( unit( p ) - 0.25 );
}
double WhiteClip( float p )
{
	return 1.0 + 0.3 * ( unit( p ) - 0.5 );
}

//--- White -----------------------------------------------------------------
double ChannelGainDb( float p )
{
	return 12.0 * ( unit( p ) - 0.5 );
}
double ChannelGain( float p )
{
	return std::pow( 10.0, ChannelGainDb( p ) / 20.0 );
}
double DriftMireds( float p )
{
	return 60.0 * unit( p );
}

//--- Matrix ----------------------------------------------------------------
double Saturation( float p )
{
	return 2.0 * unit( p );
}

//--- Detail ----------------------------------------------------------------
double DetailLevel( float p )
{
	return 3.0 * unit( p );
}
double DetailSpacing( float p )
{
	return 1.0 + 8.0 * unit( p );
}
double DetailHorizontalWeight( float p )
{
	return std::min( 1.0, 2.0 * unit( p ) );
}
double DetailVerticalWeight( float p )
{
	return std::min( 1.0, 2.0 * ( 1.0 - unit( p ) ) );
}
double CoringEdge( float p )
{
	const double q = unit( p );
	return 0.25 * q * q;
}
double LevelDependence( float p )
{
	return unit( p );
}
double SkinDetail( float p )
{
	return unit( p );
}
double SkinHueDegrees( float p )
{
	return 360.0 * unit( p );
}
double SkinWidthDegrees( float p )
{
	return 5.0 + 55.0 * unit( p );
}

//--- Knee ------------------------------------------------------------------
double KneePoint( float p )
{
	return 0.4 + 0.6 * unit( p );
}
double KneeSlope( float p )
{
	return 1.0 - 0.95 * ( 1.0 - unit( p ) );
}

//--- Gamma -----------------------------------------------------------------
double GammaExponent( float p )
{
	return 0.45 + 0.2 * ( unit( p ) - 0.5 );
}
double BlackGamma( float p )
{
	return unit( p );
}

//--- Output ----------------------------------------------------------------
double Mix( float p )
{
	return unit( p );
}

} // namespace ccu::controls
