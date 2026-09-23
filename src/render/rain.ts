// Rain streaks: a wrapped box of line segments that follows the camera (one draw call).
import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aEnd;
uniform vec3 uCam;
uniform vec3 uBox;
uniform float uTime;
uniform vec3 uVel;
uniform float uLen;
varying float vA;
varying float vDepth;
void main() {
	// position = random seed in [0,1)^3
	vec3 p = position * uBox + uVel * uTime;
	vec3 origin = uCam - uBox * 0.5;
	p = origin + mod( p - origin, uBox );
	// streak tail extends backward along velocity (motion-blurred drop)
	p -= normalize( uVel ) * uLen * aEnd;
	vec4 mv = modelViewMatrix * vec4( p, 1.0 );
	vDepth = -mv.z;
	vA = 1.0 - aEnd * 0.8;
	gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
varying float vDepth;
void main() {
	float fade = smoothstep( 0.5, 2.5, vDepth ) * ( 1.0 - smoothstep( 18.0, 28.0, vDepth ) );
	gl_FragColor = vec4( uColor, uOpacity * vA * fade );
}
`;

export class Rain {
  readonly object: THREE.LineSegments;
  readonly material: THREE.ShaderMaterial;
  private count: number;
  constructor(count = 9000) {
    this.count = count;
    const pos = new Float32Array(count * 2 * 3);
    const end = new Float32Array(count * 2);
    let s = 1234567;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      const x = r(), y = r(), z = r();
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2] = 0;
      end[i * 2 + 1] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(50, 30, 50) },
        uTime: { value: 0 },
        uVel: { value: new THREE.Vector3(1.2, -9.5, 0.6) },
        uLen: { value: 0.55 },
        uColor: { value: new THREE.Color(0.6, 0.65, 0.7) },
        uOpacity: { value: 0.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.LineSegments(geo, this.material);
    this.object.frustumCulled = false;
    this.object.name = 'rain';
    this.object.renderOrder = 10;
    this.object.userData.cannotReceiveAO = false;
  }

  update(dt: number, camPos: THREE.Vector3, intensity: number, ambient: THREE.Color) {
    const u = this.material.uniforms;
    u.uTime.value += dt;
    u.uCam.value.copy(camPos);
    u.uOpacity.value = intensity * 0.32;
    // rain is lit by ambient light: bright streaks under a bright sky, faint at night
    u.uColor.value.copy(ambient).multiplyScalar(1.4);
    this.object.visible = intensity > 0.01;
    const n = Math.floor(this.count * Math.min(1, intensity * 1.2));
    this.object.geometry.setDrawRange(0, n * 2);
  }
}
