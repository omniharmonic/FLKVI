// Global ShaderChunk patches so EVERY built-in material (and ShaderMaterials that include the fog
// chunks) gets aerial perspective, height fog and rain wetness without per-material setup.
//
// Shared uniforms trick: UniformsUtils.cloneUniforms deep-copies Vector/Color values but keeps plain
// objects by reference, so uniforms whose value is a plain {x,y,z,w} object stay shared across all
// materials and we can update them once per frame.
import * as THREE from 'three';

export class V4 { constructor(public x = 0, public y = 0, public z = 0, public w = 0) {} set(x: number, y: number, z: number, w: number) { this.x = x; this.y = y; this.z = z; this.w = w; return this; } }
export class V3 { constructor(public x = 0, public y = 0, public z = 0) {} set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; } }

/** Global uniform values (plain objects, shared by reference). */
export const globals = {
  /** x: height fog density at base, y: height falloff (1/m), z: base height (m), w: max fog opacity */
  fogHeight: new V4(0, 0, 0, 1),
  /** Sun direction (world). */
  sunDir: new V3(0, 1, 0),
  /** Extra in-scatter color toward the sun (added to fogColor by phase). */
  fogSun: new V3(0, 0, 0),
  /** x: wetness 0..1, y: puddles 0..1, z: time (s), w: unused */
  wet: new V4(0, 0, 0, 0),
};

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorldPos = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
	uniform vec4 gtFogHeight;
	uniform vec3 gtSunDir;
	uniform vec3 gtFogSun;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;

// Aerial perspective: exponential haze (fogDensity = extinction per meter) + analytic exponential
// height fog integrated along the view ray, tinted toward the sun by a Mie-like lobe.
const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		vec3 gtRay = vFogWorldPos - cameraPosition;
		float gtDist = length( gtRay );
		vec3 gtRd = gtRay / max( gtDist, 1e-4 );
		float gtOptical = fogDensity * gtDist;
		// height fog: integral of a * exp(-b * (y - base)) along the ray
		float gtB = max( gtFogHeight.y, 1e-5 );
		float gtRdy = gtRd.y;
		float gtStart = exp( - gtB * ( cameraPosition.y - gtFogHeight.z ) );
		float gtH = abs( gtRdy ) > 1e-3 ? ( 1.0 - exp( - gtB * gtRdy * gtDist ) ) / ( gtB * gtRdy ) : gtDist;
		gtOptical += gtFogHeight.x * min( gtStart, 50.0 ) * gtH;
		float fogFactor = 1.0 - exp( - gtOptical );
		fogFactor = min( fogFactor, gtFogHeight.w > 0.0 ? gtFogHeight.w : 1.0 );
		float gtSunAmt = pow( max( dot( gtRd, gtSunDir ), 0.0 ), 6.0 );
		vec3 gtFogCol = fogColor + gtFogSun * gtSunAmt;
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		vec3 gtFogCol = fogColor;
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, gtFogCol, fogFactor );
#endif
`;

// Wet surfaces: darker porous albedo, lower roughness, flattened normals in puddles on up-facing surfaces.
const WET_PARS = /* glsl */ `
uniform vec4 gtWet;
float gtHash12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float gtVNoise( vec2 p ) {
	vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( gtHash12( i ), gtHash12( i + vec2( 1, 0 ) ), f.x ), mix( gtHash12( i + vec2( 0, 1 ) ), gtHash12( i + vec2( 1, 1 ) ), f.x ), f.y );
}
`;

const WET_APPLY = /* glsl */ `
#if defined( STANDARD )
if ( gtWet.x > 0.001 ) {
	vec3 gtUpV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
	float gtUp = dot( normal, gtUpV );
	vec3 gtWP = ( - vViewPosition - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
	float gtHoriz = smoothstep( 0.55, 0.92, gtUp );
	float gtN = gtVNoise( gtWP.xz * 0.22 ) * 0.65 + gtVNoise( gtWP.xz * 0.9 ) * 0.35;
	float gtPuddle = smoothstep( 0.52, 0.64, gtN ) * gtHoriz * gtWet.y;
	float gtWetAmt = gtWet.x * ( 0.3 + 0.7 * gtHoriz );
	float gtPorous = gtWetAmt * ( 1.0 - metalnessFactor );
	diffuseColor.rgb *= mix( 1.0, 0.5, gtPorous * ( 1.0 - roughnessFactor * 0.3 ) );
	diffuseColor.rgb *= mix( 1.0, 0.75, gtPuddle );
	roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.4 + 0.08, gtWetAmt );
	roughnessFactor = mix( roughnessFactor, 0.02, gtPuddle );
	normal = normalize( mix( normal, gtUpV, gtPuddle * 0.95 ) );
}
#endif
`;

let patched = false;

/** Patch ShaderChunk + ShaderLib uniforms. Must run before any material compiles. Idempotent. */
export function patchShaderChunks() {
  if (patched) return;
  patched = true;
  const SC = THREE.ShaderChunk as unknown as Record<string, string>;
  SC.fog_pars_vertex = FOG_PARS_VERTEX;
  SC.fog_vertex = FOG_VERTEX;
  SC.fog_pars_fragment = FOG_PARS_FRAGMENT;
  SC.fog_fragment = FOG_FRAGMENT;
  SC.lights_physical_pars_fragment = WET_PARS + SC.lights_physical_pars_fragment;
  SC.lights_physical_fragment = WET_APPLY + SC.lights_physical_fragment;
  // perf: the scene keeps ~20 pooled spot/point lights (streetlights, headlights, sirens, searchlights) in the
  // scene permanently so toggling them never recompiles shaders - but three evaluates the full BRDF for every
  // one of them on every fragment, even at intensity 0 or out of range (this was the single largest GPU cost:
  // ~8 ms/frame on an M4 at 1024x576). Skip RE_Direct for invisible point/spot lights; zero-color lights add
  // exactly nothing, so the image is unchanged.
  const lfb = SC.lights_fragment_begin;
  const cut = lfb.indexOf('#if ( NUM_SUN_LIGHTS > 0 )');
  if (cut > 0) {
    const RE = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
    const head = lfb.slice(0, cut).split(RE).join('if ( directLight.visible ) ' + RE);
    SC.lights_fragment_begin = head + lfb.slice(cut);
  }

  const lib = THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, THREE.IUniform> }>;
  for (const key of Object.keys(lib)) {
    const u = lib[key].uniforms;
    if (u && 'fogColor' in u) {
      u.gtFogHeight = { value: globals.fogHeight };
      u.gtSunDir = { value: globals.sunDir };
      u.gtFogSun = { value: globals.fogSun };
    }
    if (u && (key === 'standard' || key === 'physical')) {
      u.gtWet = { value: globals.wet };
    }
  }
  // UniformsLib.fog is what custom ShaderMaterials merge in; add ours there too.
  const fogLib = THREE.UniformsLib.fog as unknown as Record<string, THREE.IUniform>;
  fogLib.gtFogHeight = { value: globals.fogHeight };
  fogLib.gtSunDir = { value: globals.sunDir };
  fogLib.gtFogSun = { value: globals.fogSun };
}

/**
 * For custom ShaderMaterials built on MeshStandard/Physical chunks by other modules: merge the
 * shared global uniforms so fog + wetness work (not needed for built-in materials).
 */
export function addGlobalUniforms(uniforms: Record<string, THREE.IUniform>) {
  uniforms.gtFogHeight = { value: globals.fogHeight };
  uniforms.gtSunDir = { value: globals.sunDir };
  uniforms.gtFogSun = { value: globals.fogSun };
  uniforms.gtWet = { value: globals.wet };
  return uniforms;
}
