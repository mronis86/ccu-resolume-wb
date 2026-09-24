#include "Ccu.h"

#include "Controls.h"
#include "Diag.h"
#include "Model.h"
#include "Shaders.h"

//FFGLSDK.h includes every other scoped binding and omits this one (SDK
//b1afaf9). The symptom without it is an unknown-type error on
//ScopedFBOBinding and nothing else.
#include <ffglex/FFGLScopedFBOBinding.h>

#include <algorithm>
#include <cmath>
#include <string>

using namespace ffglex;
using namespace ccu;

static CFFGLPluginInfo PluginInfo(
	PluginFactory< Ccu >,// Create method
	"CC01",              // Plugin unique ID of maximum length 4.
	"SW CCU",            // Plugin name
	2,                   // API major version number
	1,                   // API minor version number
	0,                   // Plugin major version number
	1,                   // Plugin minor version number
	FF_EFFECT,           // Plugin type
	"A broadcast camera's processing chain with every knob out.\n\nNot a filter: the stages of a studio or OB camera in their fixed order, in linear light - white balance, matrix, detail (aperture correction), knee, gamma and black gamma, pedestal, white clip - each labelled the way a CCU labels it. The badly set-up camera looks fall out: halos the width of the detail delay, grain sharpened by a low coring, faces softened by skin detail, skies that keep colour through the knee, a warm white that clips in one channel first, and a white balance that drifts as the camera warms up.\n\nStart with Detail Level and Coring, then the Knee.",// Plugin description
	"CCU FFGL effect"    // About
);

namespace
{
/// glGetString returns nullptr with no current context; a log line must never
/// be the thing that brings the host down.
std::string glStringOrUnknown( GLenum name )
{
	const GLubyte* value = glGetString( name );
	return value ? reinterpret_cast< const char* >( value ) : "unknown";
}

GLint loc( const FFGLShader& shader, const char* name )
{
	return glGetUniformLocation( shader.GetGLID(), name );
}

float f( double v )
{
	return static_cast< float >( v );
}
} // namespace

//---------------------------------------------------------------------------
Ccu::Ccu()
{
	SetMinInputs( 1 );
	SetMaxInputs( 1 );

	//The drift is the one thing here that moves with time.
	SetTimeSupported( true );

	//---------------------------------------------------------------------
	// Defaults. Filled BEFORE any declaration: SetParamInfof reads its
	// default out of GetFloatParameter.
	//
	// They add up to a camera somebody set up in a hurry: a touch of
	// detail at a two-pixel delay with the coring low enough to show it,
	// the knee on with a soft slope so the top of the picture goes milky,
	// a little black gamma, the Standard matrix, and a slow drift. The
	// null is Mix at zero.
	//---------------------------------------------------------------------
	params[ PT_MASTER_GAIN ]  = 0.25f;  //exactly 0 dB
	params[ PT_MASTER_BLACK ] = 0.25f;  //exactly 0
	params[ PT_WHITE_CLIP ]   = 0.5f;   //exactly 1.0
	params[ PT_R_GAIN ]       = 0.5f;   //exactly 0 dB
	params[ PT_B_GAIN ]       = 0.5f;
	params[ PT_DRIFT ]        = 0.15f;  //9 mireds RMS, tau 20 s
	params[ PT_MATRIX ]       = static_cast< float >( model::kMatrixStandard );
	params[ PT_SATURATION ]   = 0.5f;   //exactly 1
	params[ PT_DETAIL_LEVEL ] = 0.3f;   //0.9: a step of h overshoots by 0.225 h
	params[ PT_DETAIL_FREQ ]  = 0.125f; //exactly 2 px
	params[ PT_HV_RATIO ]     = 0.5f;   //both exactly 1
	params[ PT_CORING ]       = 0.3f;   //an edge below 0.0225 linear gets no detail
	params[ PT_LEVEL_DEP ]    = 0.5f;
	params[ PT_SKIN_DETAIL ]  = 0.4f;
	params[ PT_SKIN_HUE ]     = 0.0556f;//20 degrees, a skin tone in linear RGB
	params[ PT_SKIN_WIDTH ]   = 0.2727f;//+-20 degrees
	params[ PT_KNEE_ON ]      = 1.0f;
	params[ PT_KNEE_POINT ]   = 0.5f;   //0.7 linear
	params[ PT_KNEE_SLOPE ]   = 0.25f;  //0.29
	params[ PT_GAMMA ]        = 0.5f;   //exactly 0.45
	params[ PT_BLACK_GAMMA ]  = 0.2f;
	params[ PT_MIX ]          = 1.0f;
	params[ PT_SHOW_DETAIL ]  = 0.0f;

	SetParamInfof( PT_MASTER_GAIN, "Master Gain", FF_TYPE_STANDARD );
	SetParamInfof( PT_MASTER_BLACK, "Master Black", FF_TYPE_STANDARD );
	SetParamInfof( PT_WHITE_CLIP, "White Clip", FF_TYPE_STANDARD );

	SetParamInfof( PT_R_GAIN, "R Gain", FF_TYPE_STANDARD );
	SetParamInfof( PT_B_GAIN, "B Gain", FF_TYPE_STANDARD );
	SetParamInfof( PT_DRIFT, "Drift", FF_TYPE_STANDARD );

	//Enum order, not alphabetical: Identity, Standard, High Saturation,
	//Film-like reads as a progression from "off".
	SetOptionParamInfo( PT_MATRIX, "Matrix", model::kMatrixCount, params[ PT_MATRIX ] );
	for( int i = 0; i < model::kMatrixCount; ++i )
		SetParamElementInfo( PT_MATRIX, static_cast< unsigned int >( i ), model::kMatrixNames[ i ], static_cast< float >( i ) );
	SetParamInfof( PT_SATURATION, "Saturation", FF_TYPE_STANDARD );

	SetParamInfof( PT_DETAIL_LEVEL, "Detail Level", FF_TYPE_STANDARD );
	SetParamInfof( PT_DETAIL_FREQ, "Crispening Freq", FF_TYPE_STANDARD );
	SetParamInfof( PT_HV_RATIO, "H/V Ratio", FF_TYPE_STANDARD );
	SetParamInfof( PT_CORING, "Coring", FF_TYPE_STANDARD );
	SetParamInfof( PT_LEVEL_DEP, "Level Dependence", FF_TYPE_STANDARD );
	SetParamInfof( PT_SKIN_DETAIL, "Skin Detail", FF_TYPE_STANDARD );
	SetParamInfof( PT_SKIN_HUE, "Skin Hue", FF_TYPE_STANDARD );
	SetParamInfof( PT_SKIN_WIDTH, "Skin Width", FF_TYPE_STANDARD );

	SetParamInfo( PT_KNEE_ON, "Knee On", FF_TYPE_BOOLEAN, params[ PT_KNEE_ON ] >= 0.5f );
	SetParamInfof( PT_KNEE_POINT, "Knee Point", FF_TYPE_STANDARD );
	SetParamInfof( PT_KNEE_SLOPE, "Knee Slope", FF_TYPE_STANDARD );

	SetParamInfof( PT_GAMMA, "Gamma", FF_TYPE_STANDARD );
	SetParamInfof( PT_BLACK_GAMMA, "Black Gamma", FF_TYPE_STANDARD );

	SetParamInfof( PT_MIX, "Mix", FF_TYPE_STANDARD );
	SetParamInfo( PT_SHOW_DETAIL, "Show Detail", FF_TYPE_BOOLEAN, false );

	for( FFUInt32 i = PT_MASTER_GAIN; i <= PT_WHITE_CLIP; ++i )
		SetParamGroup( i, "Exposure" );
	for( FFUInt32 i = PT_R_GAIN; i <= PT_DRIFT; ++i )
		SetParamGroup( i, "White" );
	for( FFUInt32 i = PT_MATRIX; i <= PT_SATURATION; ++i )
		SetParamGroup( i, "Matrix" );
	for( FFUInt32 i = PT_DETAIL_LEVEL; i <= PT_SKIN_WIDTH; ++i )
		SetParamGroup( i, "Detail" );
	for( FFUInt32 i = PT_KNEE_ON; i <= PT_KNEE_SLOPE; ++i )
		SetParamGroup( i, "Knee" );
	for( FFUInt32 i = PT_GAMMA; i <= PT_BLACK_GAMMA; ++i )
		SetParamGroup( i, "Gamma" );
	for( FFUInt32 i = PT_MIX; i <= PT_SHOW_DETAIL; ++i )
		SetParamGroup( i, "Output" );

	// The About block. Inline, because SetParamInfo is protected on
	// CFFGLPlugin and nothing outside the class can call it.
	SetParamInfo( PT_ABOUT_FIRST, "About", FF_TYPE_TEXT, stoatworks::about::defaultText() );
	{
		FFUInt32 aboutId = PT_ABOUT_FIRST + 1;
		for( const auto& b : stoatworks::about::buttons() )
			SetParamInfo( aboutId++, b.label, FF_TYPE_EVENT, false );
	}
	for( FFUInt32 i = PT_ABOUT_FIRST; i < PT_COUNT; ++i )
		SetParamGroup( i, "About" );

	FFGLLog::LogToHost( "Created CCU effect" );
	diag::init();
}

//---------------------------------------------------------------------------
FFResult Ccu::InitGL( const FFGLViewportStruct* vp )
{
	diag::info( std::string( "GL vendor=" ) + glStringOrUnknown( GL_VENDOR ) + " renderer=" + glStringOrUnknown( GL_RENDERER )
	            + " version=" + glStringOrUnknown( GL_VERSION ) );

	struct Stage
	{
		FFGLShader* shader;
		const char* fragment;
		const char* name;
	};
	const Stage stages[] = {
		{ &linearShader, shaders::kLinear, "linear" },
		{ &processShader, shaders::kProcess, "process" },
	};
	for( const Stage& stage : stages )
	{
		if( stage.shader->Compile( shaders::kVertex, stage.fragment ) )
			continue;
		//Invisible to the operator otherwise: the effect does nothing in
		//Resolume, with no message anywhere.
		diag::error( std::string( "the " ) + stage.name + " shader failed to compile - the effect will do nothing" );
		FFGLLog::LogToHost( "CCU: shader failed to compile" );
		DeInitGL();
		return FF_FAIL;
	}

	if( !quad.Initialise() )
	{
		diag::error( "quad geometry failed to initialise" );
		DeInitGL();
		return FF_FAIL;
	}

	clock.Reset();
	lastNow    = 0.0;
	driftWalk  = 0.0;
	frameIndex = 0;

	diag::info( "initialised" );
	return CFFGLPlugin::InitGL( vp );
}

//---------------------------------------------------------------------------
FFResult Ccu::ProcessOpenGL( ProcessOpenGLStruct* pGL )
{
	if( pGL->numInputTextures < 1 || pGL->inputTextures[ 0 ] == nullptr )
		return FF_FAIL;

	const FFGLTextureStruct& picture = *pGL->inputTextures[ 0 ];
	if( picture.Width == 0 || picture.Height == 0 )
		return FF_FAIL;

	//The host's viewport, before anything of ours changes it:
	//ScopedFBOBinding restores the framebuffer binding and only that.
	GLint hostViewport[ 4 ] = { 0, 0, 0, 0 };
	glGetIntegerv( GL_VIEWPORT, hostViewport );

	const int W = static_cast< int >( picture.Width );
	const int H = static_cast< int >( picture.Height );

	//---------------------------------------------------------------------
	// The clock and the drift, in double.
	//---------------------------------------------------------------------
	clock.Update( hostTime );
	const double now = clock.Now();
	const double dt  = std::max( 0.0, now - lastNow );
	lastNow          = now;
	driftWalk        = model::DriftStep( driftWalk, dt, frameIndex );
	++frameIndex;

	//---------------------------------------------------------------------
	// The settings, in physical units.
	//---------------------------------------------------------------------
	const double masterGain = controls::MasterGain( params[ PT_MASTER_GAIN ] );
	const double pedestal   = controls::MasterBlack( params[ PT_MASTER_BLACK ] );
	const double whiteClip  = controls::WhiteClip( params[ PT_WHITE_CLIP ] );

	const double shiftMired = controls::DriftMireds( params[ PT_DRIFT ] ) * driftWalk;
	const double gainR      = controls::ChannelGain( params[ PT_R_GAIN ] ) * std::exp( model::kDriftGainPerMired * shiftMired );
	const double gainB      = controls::ChannelGain( params[ PT_B_GAIN ] ) * std::exp( -model::kDriftGainPerMired * shiftMired );

	const int preset          = model::OptionIndex( params[ PT_MATRIX ], model::kMatrixCount );
	const model::Mat3 matrix  = model::Saturation( controls::Saturation( params[ PT_SATURATION ] ) ) * model::PresetMatrix( preset );

	const double detailLevel = controls::DetailLevel( params[ PT_DETAIL_LEVEL ] );
	const double spacing     = controls::DetailSpacing( params[ PT_DETAIL_FREQ ] );
	const int spacingInt     = static_cast< int >( std::floor( spacing ) );
	const double spacingFrac = spacing - spacingInt;
	const double hWeight     = controls::DetailHorizontalWeight( params[ PT_HV_RATIO ] );
	const double vWeight     = controls::DetailVerticalWeight( params[ PT_HV_RATIO ] );
	const double coringDead  = controls::CoringEdge( params[ PT_CORING ] ) * model::kDetailStepPeak;
	const double levelDep    = controls::LevelDependence( params[ PT_LEVEL_DEP ] );
	const double skinDetail  = controls::SkinDetail( params[ PT_SKIN_DETAIL ] );
	const double skinHue     = controls::SkinHueDegrees( params[ PT_SKIN_HUE ] );
	const double skinWidth   = controls::SkinWidthDegrees( params[ PT_SKIN_WIDTH ] );

	const bool kneeOn      = params[ PT_KNEE_ON ] >= 0.5f;
	const double kneePoint = controls::KneePoint( params[ PT_KNEE_POINT ] );
	//Perturb 16: the slope 10% steeper than the control says (a negative control).
	const double kneeSlope = controls::KneeSlope( params[ PT_KNEE_SLOPE ] ) * ( ( perturb & model::kPerturbKneeSlope ) ? 1.1 : 1.0 );

	//Perturb 64: the exponent 0.05 above the control (a negative control).
	const double exponent    = controls::GammaExponent( params[ PT_GAMMA ] ) + ( ( perturb & model::kPerturbGammaExponent ) ? 0.05 : 0.0 );
	const model::Oetf oetf   = model::OetfFor( exponent );
	const model::Oetf inverse = model::OetfFor( model::kOetfExponentNull );
	const double blackGamma  = controls::BlackGamma( params[ PT_BLACK_GAMMA ] );

	const bool showDetail = params[ PT_SHOW_DETAIL ] >= 0.5f;
	const double mix      = controls::Mix( params[ PT_MIX ] );

	//---------------------------------------------------------------------
	// The buffer. Allocated before anything binds a texture: every ffglex
	// Scoped* binding CLEARS to 0 on exit, and FFGLFBO::Initialise sizes
	// its colour texture under one.
	//---------------------------------------------------------------------
	if( !linear.Ensure( W, H, GL_RGBA32F, PassBuffer::Sampling::Nearest ) )
	{
		diag::error( "could not allocate the linear buffer: " + std::to_string( W ) + " x " + std::to_string( H ) );
		return FF_FAIL;
	}

	const FFGLTexCoords maxCoords = GetMaxGLTexCoords( picture );

	//---------------------------------------------------------------------
	// 1. linear
	//---------------------------------------------------------------------
	{
		ScopedFBOBinding fbo( linear.GetGLID(), ScopedFBOBinding::RB_REVERT );
		linear.ResizeViewPort();
		ScopedShaderBinding shader( linearShader.GetGLID() );
		ScopedSamplerActivation s0( 0 );
		Scoped2DTextureBinding input( picture.Handle );

		linearShader.Set( "InputTexture", 0 );
		linearShader.Set( "MaxUV", maxCoords.s, maxCoords.t );
		linearShader.Set( "MasterGain", f( masterGain ) );
		linearShader.Set( "GainR", f( gainR ) );
		linearShader.Set( "GainB", f( gainB ) );
		{
			float m[ 9 ];
			for( int i = 0; i < 3; ++i )
				for( int j = 0; j < 3; ++j )
					m[ i * 3 + j ] = f( matrix.m[ i ][ j ] );
			//Row-major on the CPU, so transposed on the way in.
			glUniformMatrix3fv( loc( linearShader, "Matrix" ), 1, GL_TRUE, m );
		}
		linearShader.Set( "InvA", f( inverse.a ) );
		linearShader.Set( "InvC", f( inverse.a - 1.0 ) );
		linearShader.Set( "InvK", f( inverse.k ) );
		linearShader.Set( "InvKnee", f( inverse.knee ) );
		linearShader.Set( "InvGamma", f( 1.0 / inverse.gamma ) );
		linearShader.Set( "Perturb", perturb );
		linearShader.Set( "KneeOn", kneeOn ? 1 : 0 );
		linearShader.Set( "KneePoint", f( kneePoint ) );
		linearShader.Set( "KneeSlope", f( kneeSlope ) );
		quad.Draw();
	}

	//---------------------------------------------------------------------
	// 2. process, straight into the host's framebuffer.
	//---------------------------------------------------------------------
	{
		glBindFramebuffer( GL_FRAMEBUFFER, pGL->HostFBO );
		glViewport( hostViewport[ 0 ], hostViewport[ 1 ], hostViewport[ 2 ], hostViewport[ 3 ] );

		ScopedShaderBinding shader( processShader.GetGLID() );
		ScopedSamplerActivation s0( 0 );
		Scoped2DTextureBinding lin( linear.TextureID() );
		ScopedSamplerActivation s1( 1 );
		Scoped2DTextureBinding input( picture.Handle );

		processShader.Set( "LinearTexture", 0 );
		processShader.Set( "InputTexture", 1 );
		processShader.Set( "MaxUV", maxCoords.s, maxCoords.t );
		processShader.Set( "PictureW", W );
		processShader.Set( "PictureH", H );

		processShader.Set( "DetailLevel", f( detailLevel ) );
		processShader.Set( "SpacingInt", spacingInt );
		processShader.Set( "SpacingFrac", f( spacingFrac ) );
		processShader.Set( "HWeight", f( hWeight ) );
		processShader.Set( "VWeight", f( vWeight ) );
		processShader.Set( "CoringDead", f( coringDead ) );
		processShader.Set( "LevelDep", f( levelDep ) );
		processShader.Set( "LevelRef", f( model::kLevelDependenceRef ) );
		processShader.Set( "SkinSuppress", f( skinDetail ) );
		processShader.Set( "SkinHue", f( skinHue ) );
		processShader.Set( "SkinWidth", f( skinWidth ) );
		processShader.Set( "SkinInner", f( model::kSkinInnerFraction ) );
		processShader.Set( "SkinChromaLo", f( model::kSkinChromaLow ) );
		processShader.Set( "SkinChromaHi", f( model::kSkinChromaHigh ) );

		processShader.Set( "KneeOn", kneeOn ? 1 : 0 );
		processShader.Set( "KneePoint", f( kneePoint ) );
		processShader.Set( "KneeSlope", f( kneeSlope ) );

		processShader.Set( "OetfA", f( oetf.a ) );
		processShader.Set( "OetfC", f( oetf.a - 1.0 ) );
		processShader.Set( "OetfK", f( oetf.k ) );
		processShader.Set( "OetfBreak", f( model::kOetfBreak ) );
		processShader.Set( "OetfGamma", f( oetf.gamma ) );

		processShader.Set( "BlackGamma", f( blackGamma ) );
		processShader.Set( "BlackLevel", f( model::kBlackGammaLevel ) );
		processShader.Set( "BlackLift", f( model::kBlackGammaLift ) );
		processShader.Set( "Pedestal", f( pedestal ) );
		processShader.Set( "WhiteClip", f( whiteClip ) );

		processShader.Set( "MixAmount", f( mix ) );
		processShader.Set( "ShowDetail", showDetail ? 1 : 0 );
		processShader.Set( "Perturb", perturb );
		quad.Draw();
	}

	return FF_SUCCESS;
}

//---------------------------------------------------------------------------
FFResult Ccu::DeInitGL()
{
	linearShader.FreeGLResources();
	processShader.FreeGLResources();
	quad.Release();
	linear.Destroy();
	return FF_SUCCESS;
}

//---------------------------------------------------------------------------
FFResult Ccu::SetFloatParameter( unsigned int index, float value )
{
	if( index >= PT_COUNT )
		return FF_FAIL;

	// The About buttons open a browser and store nothing.
	if( index >= PT_ABOUT_FIRST )
		return stoatworks::about::handleParam( index - PT_ABOUT_FIRST, value ) ? FF_SUCCESS : FF_FAIL;

	params[ index ] = value;
	return FF_SUCCESS;
}

float Ccu::GetFloatParameter( unsigned int index )
{
	if( index >= PT_COUNT )
		return 0.0f;
	return params[ index ];
}

char* Ccu::GetTextParameter( unsigned int index )
{
	if( index == PT_ABOUT_FIRST )
	{
		aboutText = stoatworks::about::textParam( 0 );
		return const_cast< char* >( aboutText.c_str() );
	}
	return CFFGLPlugin::GetTextParameter( index );
}

FFResult Ccu::SetTextParameter( unsigned int index, const char* value )
{
	// See the declaration: the base class fails, and a failed default deletes
	// the instance. The About line is display-only; it has to say so
	// successfully.
	if( index == PT_ABOUT_FIRST )
		return FF_SUCCESS;
	return CFFGLPlugin::SetTextParameter( index, value );
}

FFResult Ccu::SetTime( double time )
{
	hostTime = time;
	return FF_SUCCESS;
}
