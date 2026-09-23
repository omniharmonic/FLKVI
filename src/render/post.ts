// Post-processing chain (pmndrs/postprocessing):
//   RenderPass -> N8AO -> [WetSSR] -> [Bloom, Exposure+WhiteBalance, PBR-Neutral tonemap, Grade, Vignette] -> [SMAA, Grain]
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode,
  SMAAEffect, SMAAPreset, VignetteEffect, Effect, BlendFunction, EffectAttribute,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

const EXPOSURE_FRAG = /* glsl */ `
uniform float exposure;
uniform vec3 whiteBalance;
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
	outputColor = vec4( inputColor.rgb * exposure * whiteBalance, inputColor.a );
}
`;

/** Linear pre-tonemap exposure + white balance. */
export class ExposureEffect extends Effect {
  constructor() {
    super('ExposureEffect', EXPOSURE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['exposure', new THREE.Uniform(1)],
        ['whiteBalance', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
      ]),
    });
  }
  get exposure() { return this.uniforms.get('exposure')!.value as number; }
  set exposure(v: number) { this.uniforms.get('exposure')!.value = v; }
  get whiteBalance() { return this.uniforms.get('whiteBalance')!.value as THREE.Vector3; }
}

const GRADE_FRAG = /* glsl */ `
uniform float saturation;
uniform float contrast;
uniform vec3 lift;
uniform vec3 gammaAdj;
uniform vec3 gain;
uniform vec3 shadowTint;
uniform vec3 highlightTint;
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
	vec3 c = clamp( inputColor.rgb, 0.0, 1.0 );
	// work in a perceptual-ish space for grading
	vec3 p = pow( c, vec3( 1.0 / 2.2 ) );
	float l = dot( p, vec3( 0.2126, 0.7152, 0.0722 ) );
	// split toning
	p *= mix( shadowTint, highlightTint, smoothstep( 0.1, 0.8, l ) );
	// contrast around mid grey
	p = ( p - 0.45 ) * contrast + 0.45;
	// lift / gamma / gain
	p = p * gain + lift * ( 1.0 - p );
	p = pow( max( p, 0.0 ), 1.0 / gammaAdj );
	float l2 = dot( p, vec3( 0.2126, 0.7152, 0.0722 ) );
	p = mix( vec3( l2 ), p, saturation );
	outputColor = vec4( pow( clamp( p, 0.0, 1.0 ), vec3( 2.2 ) ), inputColor.a );
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', GRADE_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['saturation', new THREE.Uniform(1)],
        ['contrast', new THREE.Uniform(1)],
        ['lift', new THREE.Uniform(new THREE.Vector3(0, 0, 0))],
        ['gammaAdj', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['gain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['shadowTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['highlightTint', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
      ]),
    });
  }
  u(name: string) { return this.uniforms.get(name)!; }
}

const GRAIN_FRAG = /* glsl */ `
uniform float amount;
uniform float seed;
float gHash( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
	vec2 px = floor( uv * resolution );
	float n = gHash( px + seed * 113.0 ) + gHash( px * 1.7 - seed * 71.0 ) - 1.0;
	float l = dot( inputColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	// grain strongest in mids, weaker in deep shadows and highlights (film-like)
	float w = amount * ( 0.35 + 0.65 * smoothstep( 0.0, 0.25, l ) * ( 1.0 - smoothstep( 0.6, 1.0, l ) ) );
	outputColor = vec4( max( inputColor.rgb + n * w * max( l, 0.02 ), 0.0 ), inputColor.a );
}
`;

export class GrainEffect extends Effect {
  constructor() {
    super('GrainEffect', GRAIN_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['amount', new THREE.Uniform(0.06)],
        ['seed', new THREE.Uniform(0)],
      ]),
    });
  }
  update(_r: THREE.WebGLRenderer, _i: THREE.WebGLRenderTarget, dt?: number) {
    const s = this.uniforms.get('seed')!;
    s.value = (s.value + (dt ?? 0.016) * 7.31) % 100;
  }
}


const SSR_FRAG = /* glsl */ `
uniform mat4 camWorld;
uniform mat4 projMat;
uniform mat4 projInv;
uniform vec4 wetParams; // x wetness, y puddles, z strength, w max steps scale
float sHash( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float sNoise( vec2 p ) {
	vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( sHash( i ), sHash( i + vec2( 1, 0 ) ), f.x ), mix( sHash( i + vec2( 0, 1 ) ), sHash( i + vec2( 1, 1 ) ), f.x ), f.y );
}
vec2 projectUV( vec3 p ) { vec4 c = projMat * vec4( p, 1.0 ); return c.xy / c.w * 0.5 + 0.5; }
float sViewZ( float d ) { return ( cameraNear * cameraFar ) / ( ( cameraFar - cameraNear ) * d - cameraFar ); }
vec3 sViewPos( vec2 uv, float d ) { vec4 c = projInv * vec4( vec3( uv, d ) * 2.0 - 1.0, 1.0 ); return c.xyz / c.w; }
void mainImage( const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor ) {
	outputColor = inputColor;
	if ( wetParams.w > 2.5 ) { outputColor = vec4( fract( depth * 100.0 ), depth > 0.9999 ? 1.0 : 0.0, wetParams.x, 1.0 ); return; }
	if ( wetParams.x < 0.02 || depth >= 0.9999 ) return;
	vec3 vp = sViewPos( uv, depth );
	vec3 nV = normalize( cross( dFdx( vp ), dFdy( vp ) ) );
	vec3 nW = mat3( camWorld ) * nV;
	if ( nW.y < 0.85 ) return;
	vec3 wp = ( camWorld * vec4( vp, 1.0 ) ).xyz;
	float n = sNoise( wp.xz * 0.22 ) * 0.65 + sNoise( wp.xz * 0.9 ) * 0.35;
	float puddle = smoothstep( 0.52, 0.64, n ) * wetParams.y;
	vec3 vd = normalize( vp );
	vec3 r = reflect( vd, nV );
	if ( r.z > 0.3 ) return; // reflecting back toward the camera: off screen
	float cosT = clamp( dot( -vd, nV ), 0.0, 1.0 );
	float fres = 0.02 + 0.98 * pow( 1.0 - cosT, 5.0 );
	float strength = wetParams.x * mix( 0.11, 1.0, puddle ) * fres * wetParams.z * ( 1.0 - smoothstep( 60.0, 250.0, -vp.z ) * 0.6 );
	if ( strength < 0.01 ) return;
	// jitter start to hide banding; rough (non-puddle) wet surfaces get a slightly blurred direction
	float j = sHash( gl_FragCoord.xy );
	vec3 p = vp + nV * 0.05;
	float stepLen = 0.25 * ( 1.0 + j );
	vec3 hitColor = vec3( 0.0 );
	float hit = 0.0;
	vec2 huv = vec2( 0.0 );
	for ( int i = 0; i < 28; i ++ ) {
		vec3 q = p + r * stepLen;
		vec2 suv = projectUV( q );
		if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 || q.z > -0.05 ) break;
		float sd = readDepth( suv );
		float sz = sViewZ( sd );
		float dz = sz - q.z; // > 0: ray is behind the surface
		if ( dz > 0.0 && dz < max( stepLen * 1.6, 0.4 ) && sd < 0.9999 ) {
			// refine
			vec3 a = p, b = q;
			for ( int k = 0; k < 5; k ++ ) {
				vec3 m = ( a + b ) * 0.5;
				vec2 muv = projectUV( m );
				if ( sViewZ( readDepth( muv ) ) - m.z > 0.0 ) b = m; else a = m;
			}
			huv = projectUV( b );
			hit = 1.0;
			break;
		}
		p = q;
		stepLen *= 1.3;
	}
	if ( wetParams.w > 1.5 ) { outputColor = vec4( hit, strength * 4.0, nW.y > 0.85 ? 0.3 : 0.0, 1.0 ); return; }
	if ( hit < 0.5 ) return;
	vec2 edge = smoothstep( 0.0, 0.08, huv ) * ( 1.0 - smoothstep( 0.92, 1.0, huv ) );
	float fade = edge.x * edge.y;
	vec3 rc = texture2D( inputBuffer, huv ).rgb;
	rc = min( rc, vec3( 30.0 ) );
	// roughness blur approximation for non-puddle wet surfaces: pull toward a mip-less blurred average
	outputColor = vec4( inputColor.rgb + rc * strength * fade, inputColor.a );
}
`;

/** Screen-space reflections restricted to wet, up-facing surfaces (roads, sidewalks, roofs). */
export class WetReflectionEffect extends Effect {
  constructor() {
    super('WetReflectionEffect', SSR_FRAG, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['camWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['projMat', new THREE.Uniform(new THREE.Matrix4())],
        ['projInv', new THREE.Uniform(new THREE.Matrix4())],
        ['wetParams', new THREE.Uniform(new THREE.Vector4(0, 0, 0.9, 1))],
      ]),
    });
  }
  camera: THREE.Camera | null = null;
  update() {
    const c = this.camera;
    if (!c) return;
    (this.uniforms.get('camWorld')!.value as THREE.Matrix4).copy(c.matrixWorld);
    (this.uniforms.get('projMat')!.value as THREE.Matrix4).copy(c.projectionMatrix);
    (this.uniforms.get('projInv')!.value as THREE.Matrix4).copy(c.projectionMatrixInverse);
  }
  get params() { return this.uniforms.get('wetParams')!.value as THREE.Vector4; }
}

export interface PostChain {
  composer: EffectComposer;
  renderPass: RenderPass;
  ao: any;
  bloom: BloomEffect;
  exposure: ExposureEffect;
  tone: ToneMappingEffect;
  grade: GradeEffect;
  vignette: VignetteEffect;
  smaa: SMAAEffect;
  grain: GrainEffect;
  mainPass: EffectPass;
  finalPass: EffectPass;
  bloomBaseThreshold: number;
  wetSSR: WetReflectionEffect;
  ssrPass: EffectPass;
}

export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, w: number, h: number): PostChain {
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const ao = new N8AOPostPass(scene, camera, w, h);
  // contact-level AO: tight radius so corners/curbs/under-awnings darken without dirty halos
  ao.configuration.aoRadius = 1.4;
  ao.configuration.distanceFalloff = 0.8;
  ao.configuration.intensity = 1.6;
  ao.configuration.color = new THREE.Color(0.03, 0.035, 0.05);
  ao.configuration.gammaCorrection = false;
  ao.configuration.halfRes = false;
  // rain/glass/particles should not occlude; skipping the transparency pre-pass saves ~2 ms
  ao.configuration.transparencyAware = false;
  ao.setQualityMode('Medium');
  composer.addPass(ao);

  const wetSSR = new WetReflectionEffect();
  wetSSR.camera = camera;
  const ssrPass = new EffectPass(camera, wetSSR);
  composer.addPass(ssrPass);

  const bloomBaseThreshold = 1.4;
  const bloom = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: bloomBaseThreshold,
    luminanceSmoothing: 0.35,
    intensity: 0.75,
    radius: 0.72,
    levels: 7,
  });
  const exposure = new ExposureEffect();
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL });
  const grade = new GradeEffect();
  const vignette = new VignetteEffect({ offset: 0.32, darkness: 0.42 });
  const mainPass = new EffectPass(camera, bloom, exposure, tone, grade, vignette);
  composer.addPass(mainPass);

  const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
  const grain = new GrainEffect();
  const finalPass = new EffectPass(camera, smaa, grain);
  finalPass.dithering = true;
  composer.addPass(finalPass);

  return { composer, renderPass, ao, bloom, exposure, tone, grade, vignette, smaa, grain, mainPass, finalPass, bloomBaseThreshold, wetSSR, ssrPass };
}
