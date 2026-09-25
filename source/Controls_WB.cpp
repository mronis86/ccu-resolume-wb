#include "Controls.h"
#include <cmath>

namespace ccu::controls
{

double ColorTempKelvin( float p )
{
    return 2000.0 + 8000.0 * static_cast<double>( p );
}

void ColorTempGains( double kelvin, double& gainR, double& gainB )
{
    // Reference is 5600K. Mired shift from reference.
    const double refMired = 1000000.0 / 5600.0;
    const double mired    = 1000000.0 / kelvin;
    const double shift    = mired - refMired;
    // ~0.004 gain per mired, R and B in opposite directions.
    const double kGainPerMired = 0.004;
    gainR = std::exp( +kGainPerMired * shift );
    gainB = std::exp( -kGainPerMired * shift );
}

double TintGain( float p )
{
    // 0.5 = unity, range 0.5x .. 2x on green channel.
    return std::exp( 1.386294 * ( static_cast<double>( p ) - 0.5 ) );
}

} // namespace ccu::controls
