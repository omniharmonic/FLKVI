// Rain streaks: a wrapped box of line segments that follows the camera (one draw call).
import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float aEnd;
attribute float aRnd;
uniform vec3 uCam;
uniform vec3 uBox;
uniform float uTime;
uniform vec3 uVel;
uniform float uLen;
varying float vA;
varying float vDepth;
varying float vHeight;
varying vec2 vXZ;
void main() {
	// position = random seed in [0,1)^3
	vec3 p = position * uBox + uVel * uTime;
	vec3 origin = uCam - uBox * 0.5;
	p = origin + mod( p - origin, uBox );
	// streak tail extends backward along velocity (motion-blurred drop); lengths vary per drop
	p -= normalize( uVel ) * uLen * ( 0.55 + 0.9 * aRnd ) * aEnd;
	vHeight=p.y;vXZ=p.xz;
	vec4 mv = modelViewMatrix * vec4( p, 1.0 );
	vDepth = -mv.z;
	// head bright, tail fades; per-drop brightness varies so the sheet doesn't read as uniform lines
	vA = ( 1.0 - aEnd ) * ( 0.35 + 0.65 * fract( aRnd * 7.31 ) );
	gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform sampler2D uCover;
uniform vec2 uCoverOrigin;
varying float vA;
varying float vDepth;
varying float vHeight;
varying vec2 vXZ;
void main() {
	if(vHeight < texture2D(uCover, (vXZ-uCoverOrigin)/50.0).r+0.05)discard;
	// very near drops would be huge blurred streaks: keep them faint; far ones merge into the mist
	float fade = smoothstep( 1.0, 5.0, vDepth ) * ( 1.0 - smoothstep( 14.0, 26.0, vDepth ) );
	gl_FragColor = vec4( uColor, uOpacity * vA * fade );
}
`;

export class Rain {
  readonly object: THREE.LineSegments;
  readonly material: THREE.ShaderMaterial;
  readonly splashes: THREE.Points;
  private coverData = new Float32Array(16*16).fill(-10000);
  private cover = new THREE.DataTexture(this.coverData,16,16,THREE.RedFormat,THREE.FloatType);
  private coverOrigin = new THREE.Vector2(1e6,1e6);
  private coverT = 0;
  private splashPos = new Float32Array(192*3);
  private count: number;
  constructor(count = 9000) {
    this.count = count;
    const pos = new Float32Array(count * 2 * 3);
    const end = new Float32Array(count * 2);
    const rnd = new Float32Array(count * 2);
    let s = 1234567;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < count; i++) {
      const x = r(), y = r(), z = r();
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2] = 0;
      end[i * 2 + 1] = 1;
      rnd[i * 2] = rnd[i * 2 + 1] = r();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uCover: {value:this.cover},
        uCoverOrigin: {value:this.coverOrigin},
        uCam: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(50, 30, 50) },
        uTime: { value: 0 },
        uVel: { value: new THREE.Vector3(1.2, -9.5, 0.6) },
        uLen: { value: 0.7 },
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
    this.object.userData.cannotReceiveAO = true;
    this.cover.needsUpdate=true;
    const splashGeo=new THREE.BufferGeometry();
    splashGeo.setAttribute('position',new THREE.BufferAttribute(this.splashPos,3).setUsage(THREE.DynamicDrawUsage));
    splashGeo.setAttribute('aSeed',new THREE.Float32BufferAttribute(Array.from({length:192},()=>r()),1));
    const splashMat=new THREE.ShaderMaterial({
      uniforms:{uTime:this.material.uniforms.uTime,uOpacity:this.material.uniforms.uOpacity,uColor:this.material.uniforms.uColor},
      vertexShader:`attribute float aSeed;uniform float uTime;varying float vLife;void main(){vLife=fract(uTime*2.2+aSeed*19.0);vec4 p=modelViewMatrix*vec4(position,1.0);gl_PointSize=clamp((2.0+vLife*6.0)*25.0/max(1.0,-p.z),1.0,18.0);gl_Position=projectionMatrix*p;}`,
      fragmentShader:`uniform vec3 uColor;uniform float uOpacity;varying float vLife;void main(){float r=length(gl_PointCoord-0.5)*2.0;float ring=(1.0-smoothstep(0.08,0.2,abs(r-0.65)))*(1.0-vLife);gl_FragColor=vec4(uColor,uOpacity*ring*2.0);}`,
      transparent:true,depthWrite:false,
    });
    this.splashes=new THREE.Points(splashGeo,splashMat);this.splashes.name='rain-splashes';this.splashes.frustumCulled=false;
  }

  private gustT = 0;
  update(dt: number, camPos: THREE.Vector3, intensity: number, ambient: THREE.Color, coverAt?: (x:number,z:number)=>number, wind=1) {
    const u = this.material.uniforms;
    u.uTime.value += dt;
    this.coverT-=dt;
    if(intensity>0.01 && coverAt && (this.coverT<=0 || Math.hypot(camPos.x-25-this.coverOrigin.x,camPos.z-25-this.coverOrigin.y)>3)){
      this.coverT=0.75;this.coverOrigin.set(camPos.x-25,camPos.z-25);
      for(let z=0;z<16;z++)for(let x=0;x<16;x++)this.coverData[z*16+x]=coverAt(this.coverOrigin.x+(x+0.5)*50/16,this.coverOrigin.y+(z+0.5)*50/16);
      this.cover.needsUpdate=true;
      for(let i=0;i<192;i++){
        const x=this.coverOrigin.x+((i*0.61803398875)%1)*50,z=this.coverOrigin.y+((i*0.41421356237)%1)*50;
        this.splashPos.set([x,coverAt(x,z)+0.06,z],i*3);
      }
      this.splashes.geometry.attributes.position.needsUpdate=true;
    }
    this.splashes.visible=intensity>0.01;
    this.gustT += dt;
    u.uCam.value.copy(camPos);
    // varying density: slow gusts between drizzle and downpour
    const t = this.gustT;
    const gust = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.077 + 1.3));
    u.uOpacity.value = intensity * 0.16;
    // rain is lit by the ambient sky: thin cool bluish-white streaks, never yellow
    const l = Math.max(0.05, 0.2126 * ambient.r + 0.7152 * ambient.g + 0.0722 * ambient.b);
    u.uColor.value.setRGB(0.78, 0.87, 1.0).multiplyScalar(Math.min(l * 1.2, 1.2));
    // wind sway
    (u.uVel.value as THREE.Vector3).set(wind*(1.2 + 0.8 * Math.sin(t * 0.13)), -9.5, wind*(0.6 + 0.5 * Math.sin(t * 0.09 + 2)));
    this.object.visible = intensity > 0.01;
    const n = Math.floor(this.count * Math.min(1, intensity * 1.2 * gust));
    this.object.geometry.setDrawRange(0, n * 2);
  }
}
