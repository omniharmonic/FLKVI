// Sky dome material: samples the CPU sky-view LUT, adds sun/moon disks, stars, clouds, night airglow
// and city light pollution. Outputs linear HDR radiance (tone mapped later by the composer).
import * as THREE from 'three';

export function makeSkyUniforms(texR: THREE.Texture, texM: THREE.Texture) {
  return {
    uLutR: { value: texR },
    uLutM: { value: texM },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    /** Sun irradiance scale applied to the LUT (includes weather dimming). */
    uSunE: { value: 5.0 },
    /** Sun disk radiance color (already includes transmittance). */
    uSunDisk: { value: new THREE.Color(1, 1, 1) },
    uMieG: { value: 0.8 },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    /** x: phase 0..1 (0 new, .5 full), y: brightness, z: angular radius (rad) */
    uMoon: { value: new THREE.Vector3(0.5, 1, 0.012) },
    uNight: { value: 0 },
    /** Star field rotation (celestial). */
    uStarRot: { value: new THREE.Matrix3() },
    uCityGlow: { value: new THREE.Color(0.02, 0.009, 0.003) },
    uAirglow: { value: new THREE.Color(0.0012, 0.0021, 0.0052) },
    /** x: coverage 0..1, y: density/darkness, z: time (s), w: altitude m */
    uClouds: { value: new THREE.Vector4(0.35, 0.6, 0, 1800) },
    uCloudSun: { value: new THREE.Color(1, 1, 1) },
    uCloudAmb: { value: new THREE.Color(0.3, 0.35, 0.45) },
    uWind: { value: new THREE.Vector2(6, 2) },
    /** 1 = environment capture (below horizon shows lit ground), 0 = visible dome */
    uEnvMode: { value: 0 },
    uGround: { value: new THREE.Color(0.05, 0.05, 0.05) },
    /** Overcast darkening 0..1 */
    uOvercast: { value: 0 },
    uHorizonFog: { value: new THREE.Color(0.5, 0.6, 0.7) },
    uExtraGlow: { value: 1 },
    /** Twilight afterglow (multiple scattering the single-scatter LUT misses): warm toward the sun, cool overhead. */
    uTwiWarm: { value: new THREE.Color(0, 0, 0) },
    uTwiCool: { value: new THREE.Color(0, 0, 0) },
  };
}
export type SkyUniforms = ReturnType<typeof makeSkyUniforms>;

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
	vDir = position;
	vec4 p = projectionMatrix * vec4( mat3( viewMatrix ) * position, 1.0 );
	gl_Position = p.xyww; // at far plane
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform sampler2D uLutR;
uniform sampler2D uLutM;
uniform vec3 uSunDir;
uniform float uSunE;
uniform vec3 uSunDisk;
uniform float uMieG;
uniform vec3 uMoonDir;
uniform vec3 uMoon;
uniform float uNight;
uniform mat3 uStarRot;
uniform vec3 uCityGlow;
uniform vec3 uAirglow;
uniform vec4 uClouds;
uniform vec3 uCloudSun;
uniform vec3 uCloudAmb;
uniform vec2 uWind;
uniform float uEnvMode;
uniform vec3 uGround;
uniform float uOvercast;
uniform vec3 uHorizonFog;
uniform vec3 uTwiWarm;
uniform vec3 uTwiCool;

#define PI 3.141592653589793

float hash13( vec3 p3 ) { p3 = fract( p3 * 0.1031 ); p3 += dot( p3, p3.zyx + 31.32 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float hash12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float vnoise( vec2 p ) {
	vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( hash12( i ), hash12( i + vec2( 1, 0 ) ), f.x ), mix( hash12( i + vec2( 0, 1 ) ), hash12( i + vec2( 1, 1 ) ), f.x ), f.y );
}
float fbm( vec2 p ) {
	float a = 0.5, s = 0.0;
	mat2 r = mat2( 0.8, -0.6, 0.6, 0.8 );
	for ( int i = 0; i < 5; i ++ ) { s += a * vnoise( p ); p = r * p * 2.03 + 11.7; a *= 0.5; }
	return s;
}

vec2 lutUV( vec3 d ) {
	float el = asin( clamp( d.y, -1.0, 1.0 ) );
	float az = atan( d.x, -d.z );
	if ( az < 0.0 ) az += 2.0 * PI;
	float s = sign( el ) * sqrt( abs( el ) / ( 0.5 * PI ) );
	return vec2( az / ( 2.0 * PI ), ( s + 1.0 ) * 0.5 );
}

float miePhase( float c, float g ) {
	float g2 = g * g;
	return ( 3.0 / ( 8.0 * PI ) ) * ( ( 1.0 - g2 ) * ( 1.0 + c * c ) ) / ( ( 2.0 + g2 ) * pow( 1.0 + g2 - 2.0 * g * c, 1.5 ) );
}

vec3 atmosphere( vec3 d ) {
	vec2 uv = lutUV( d );
	vec3 R = texture2D( uLutR, uv ).rgb;
	vec3 M = texture2D( uLutM, uv ).rgb;
	float c = dot( d, uSunDir );
	float pR = ( 3.0 / ( 16.0 * PI ) ) * ( 1.0 + c * c );
	// crude multiple-scattering compensation: brightens and desaturates the Rayleigh sky a little
	vec3 ms = R * 0.9 + vec3( dot( R, vec3( 0.33 ) ) ) * 0.15;
	return ( ms * pR * 4.0 * PI * 0.25 + R * pR + M * miePhase( c, uMieG ) ) * uSunE;
}

void main() {
	vec3 d = normalize( vDir );
	float below = step( d.y, 0.0 );
	// the visible dome never shows the planet: clamp to just above the horizon (terrain covers it)
	vec3 ds = d;
	if ( uEnvMode < 0.5 ) { ds.y = max( ds.y, 0.004 ); ds = normalize( ds ); }
	vec3 col = atmosphere( ds );

	// night: airglow + city light pollution concentrated near the horizon
	float horizonW = exp( - max( ds.y, 0.0 ) * 7.0 );
	col += uAirglow * ( 0.6 + 0.4 * horizonW );
	col += uCityGlow * ( horizonW * horizonW * 1.3 + 0.008 );
	{
		vec3 sh = normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) + 1e-5 );
		float toward = max( dot( normalize( vec3( ds.x, 0.0, ds.z ) + 1e-5 ), sh ), 0.0 );
		float up = max( ds.y, 0.0 );
		col += uTwiCool * ( 0.55 + 0.45 * exp( - up * 4.0 ) );
		col += uTwiWarm * ( pow( toward, 3.0 ) * 0.85 + 0.15 ) * exp( - up * 9.0 );
	}

	// stars
	if ( uNight > 0.01 && uEnvMode < 0.5 && d.y > 0.0 ) {
		vec3 sd = uStarRot * d;
		vec3 p = sd * 300.0;
		vec3 cell = floor( p );
		float h = hash13( cell );
		if ( h > 0.985 ) {
			vec3 center = cell + 0.5 + ( vec3( hash13( cell + 1.3 ), hash13( cell + 2.7 ), hash13( cell + 5.1 ) ) - 0.5 ) * 0.6;
			float dist = length( p - center );
			float mag = pow( ( h - 0.985 ) / 0.015, 6.0 );
			float star = smoothstep( 0.35, 0.0, dist ) * ( 0.02 + mag * 1.5 );
			vec3 tint = mix( vec3( 1.0, 0.8, 0.65 ), vec3( 0.7, 0.8, 1.0 ), hash13( cell + 9.1 ) );
			float ext = smoothstep( 0.0, 0.25, d.y );
			col += star * tint * uNight * ext * ( 1.0 - uOvercast );
		}
		// faint milky band
		float band = exp( - pow( dot( sd, normalize( vec3( 0.3, 0.2, 0.93 ) ) ) * 4.0, 2.0 ) );
		col += vec3( 0.0012, 0.0013, 0.0017 ) * band * ( 0.6 + 0.8 * fbm( sd.xy * 6.0 + sd.z * 3.0 ) ) * uNight * ( 1.0 - uOvercast );
	}

	// sun disk (limb darkened), hidden in env capture to keep IBL stable
	float cs = dot( d, uSunDir );
	float sunR = 0.0055;
	if ( uEnvMode < 0.5 ) {
		float a = acos( clamp( cs, -1.0, 1.0 ) );
		float disk = smoothstep( sunR, sunR * 0.85, a );
		float mu = sqrt( max( 0.0, 1.0 - pow( a / sunR, 2.0 ) ) );
		float limb = 0.4 + 0.6 * mu;
		col += uSunDisk * disk * limb * ( 1.0 - uOvercast * 0.95 );
		// moon
		float cm = dot( d, uMoonDir );
		float am = acos( clamp( cm, -1.0, 1.0 ) );
		if ( am < uMoon.z * 3.0 && uMoonDir.y > -0.05 ) {
			// point on moon sphere
			vec3 up = abs( uMoonDir.y ) > 0.99 ? vec3( 1, 0, 0 ) : vec3( 0, 1, 0 );
			vec3 mx = normalize( cross( up, uMoonDir ) );
			vec3 my = cross( uMoonDir, mx );
			vec2 q = vec2( dot( d, mx ), dot( d, my ) ) / uMoon.z;
			float r2 = dot( q, q );
			if ( r2 < 1.0 ) {
				vec3 n = normalize( q.x * mx + q.y * my - sqrt( 1.0 - r2 ) * uMoonDir );
				// the sun is effectively at infinity, so the terminator follows the real sun direction
				float lit = max( dot( n, uSunDir ), 0.0 );
				float maria = 0.75 + 0.25 * fbm( q * 3.0 + 4.0 );
				float edge = smoothstep( 1.0, 0.92, r2 );
				col = mix( col, col + vec3( 0.95, 0.97, 1.0 ) * lit * maria * 1.6 * uMoon.y, edge * ( 1.0 - uOvercast ) );
			}
			col += vec3( 0.6, 0.7, 0.9 ) * 0.01 * uMoon.y * exp( - am / ( uMoon.z * 1.2 ) ) * ( 1.0 - uOvercast );
		}
	}

	// clouds: single fbm layer on a plane, lit by sun with forward-scatter lobe
	if ( ds.y > 0.0 && uClouds.x > 0.001 ) {
		float t = uClouds.w / max( ds.y, 0.02 );
		vec2 cp = ds.xz * t;
		vec2 uvc = ( cp + uWind * uClouds.z ) * 0.00028;
		float n = fbm( uvc );
		n += 0.25 * fbm( uvc * 3.1 + 5.0 ) - 0.12;
		float cov = uClouds.x;
		float dens = smoothstep( 1.0 - cov - 0.08, 1.0 - cov + 0.32, n );
		// thickness proxy for self shadowing
		float thick = smoothstep( 1.0 - cov, 1.0, n );
		float fade = smoothstep( 0.0, 0.12, ds.y );
		dens *= fade;
		float ph = miePhase( cs, 0.55 ) * 3.0 + 0.35;
		float sunVis = mix( 1.0, 0.35, thick * uClouds.y );
		vec3 cl = uCloudSun * sunVis * ph + uCloudAmb * ( 1.0 - 0.4 * thick );
		// distant clouds dissolve into the horizon haze
		float haze = 1.0 - exp( - t * 0.00003 );
		cl = mix( cl, col, haze * 0.8 );
		col = mix( col, cl, dens * 0.95 );
	}

	// overcast: flatten to a grey-blue dome
	if ( uOvercast > 0.001 ) {
		float lum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
		col = mix( col, vec3( lum ) * vec3( 0.92, 0.96, 1.05 ), uOvercast * 0.7 );
	}

	if ( uEnvMode > 0.5 ) {
		// lower hemisphere: lit ground + a band of horizon haze
		float g = smoothstep( 0.0, -0.08, d.y );
		col = mix( col, uGround, g );
	}

	gl_FragColor = vec4( max( col, 0.0 ), 1.0 );
}
`;

export function makeSkyMaterial(uniforms: SkyUniforms, envMode: boolean) {
  const u = { ...uniforms, uEnvMode: { value: envMode ? 1 : 0 } } as unknown as Record<string, THREE.IUniform>;
  return new THREE.ShaderMaterial({
    name: envMode ? 'SkyEnv' : 'Sky',
    uniforms: u,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
}
