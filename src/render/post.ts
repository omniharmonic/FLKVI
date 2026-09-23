// Post-processing chain (pmndrs/postprocessing):
//   RenderPass -> N8AO -> [Bloom, Exposure+WhiteBalance, AgX, Grade, Vignette] -> [SMAA, Grain]
import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode,
  SMAAEffect, SMAAPreset, VignetteEffect, Effect, BlendFunction,
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
  ao.configuration.aoRadius = 3.0;
  ao.configuration.distanceFalloff = 1.2;
  ao.configuration.intensity = 2.2;
  ao.configuration.color = new THREE.Color(0.02, 0.025, 0.035);
  ao.configuration.gammaCorrection = false;
  ao.configuration.halfRes = false;
  // rain/glass/particles should not occlude; skipping the transparency pre-pass saves ~2 ms
  ao.configuration.transparencyAware = false;
  ao.setQualityMode('Medium');
  composer.addPass(ao);

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

  return { composer, renderPass, ao, bloom, exposure, tone, grade, vignette, smaa, grain, mainPass, finalPass, bloomBaseThreshold };
}
