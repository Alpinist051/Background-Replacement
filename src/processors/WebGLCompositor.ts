import copyVert from '@/shaders/virtual-background/copy.vert?raw';
import copyFrag from '@/shaders/virtual-background/copy.frag?raw';
import backgroundBlurFrag from '@/shaders/background-blur.frag?raw';
import edgeFeatherFrag from '@/shaders/edge-feather.frag?raw';
import lightWrappingFrag from '@/shaders/light-wrapping.frag?raw';
import temporalSmoothFrag from '@/shaders/temporal-smooth.frag?raw';
import faceCorrectionFrag from '@/shaders/face-correction.frag?raw';
import type { VirtualBackgroundEffect } from '@/types/video-processing';

export interface FaceBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface WebGLCompositorInit {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  maskWidth: number;
  maskHeight: number;
}

export interface WebGLCompositorRenderOptions {
  effect: VirtualBackgroundEffect;
  blurStrength: number;
}

export class WebGLCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: OffscreenCanvas;
  private readonly width: number;
  private readonly height: number;
  private maskWidth: number;
  private maskHeight: number;

  private readonly vao: WebGLVertexArrayObject;
  private readonly vertexBuffer!: WebGLBuffer;

  private readonly copyProgram: WebGLProgram;
  private readonly temporalProgram: WebGLProgram;
  private readonly edgeProgram: WebGLProgram;
  private readonly blurProgram: WebGLProgram;
  private readonly lightProgram: WebGLProgram;
  private readonly faceProgram: WebGLProgram;

  private readonly maskFramebuffer!: WebGLFramebuffer;
  private readonly blurFramebuffer!: WebGLFramebuffer;
  private readonly lightFramebuffer!: WebGLFramebuffer;

  private videoTexture!: WebGLTexture;
  private backgroundTexture!: WebGLTexture;

  private maskCurrentTex!: WebGLTexture;
  private maskPreviousTex!: WebGLTexture;
  private maskSmoothTex!: WebGLTexture;
  private maskFeatherTex!: WebGLTexture;

  private blurTexture!: WebGLTexture;
  private lightTexture!: WebGLTexture;

  private maskReady = false;
  private faceBox: FaceBox | null = null;
  private backgroundAspect = 1.0;

  constructor(init: WebGLCompositorInit) {
    this.canvas = init.canvas;
    this.width = init.width;
    this.height = init.height;
    this.maskWidth = Math.max(2, init.maskWidth);
    this.maskHeight = Math.max(2, init.maskHeight);

    this.canvas.width = this.width;
    this.canvas.height = this.height;

    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
    if (!gl) {
      throw new Error('WebGL2 is not available in this environment.');
    }
    this.gl = gl;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    this.vao = this.createGeometry();
    this.copyProgram = this.createProgram(copyFrag);
    this.temporalProgram = this.createProgram(temporalSmoothFrag);
    this.edgeProgram = this.createProgram(edgeFeatherFrag);
    this.blurProgram = this.createProgram(backgroundBlurFrag);
    this.lightProgram = this.createProgram(lightWrappingFrag);
    this.faceProgram = this.createProgram(faceCorrectionFrag);

    this.maskFramebuffer = this.createFramebuffer();
    this.blurFramebuffer = this.createFramebuffer();
    this.lightFramebuffer = this.createFramebuffer();

    this.videoTexture = this.createVideoTexture();
    this.backgroundTexture = this.createBackgroundTexture();

    this.maskCurrentTex = this.createMaskTexture(this.maskWidth, this.maskHeight);
    this.maskPreviousTex = this.createMaskTexture(this.maskWidth, this.maskHeight);
    this.maskSmoothTex = this.createMaskTexture(this.maskWidth, this.maskHeight);
    this.maskFeatherTex = this.createMaskTexture(this.maskWidth, this.maskHeight);

    this.blurTexture = this.createRenderTexture(this.width, this.height);
    this.lightTexture = this.createRenderTexture(this.width, this.height);

    this.fillBackgroundFallback();
  }

  updateMask(maskData: Uint8Array, width: number, height: number): void {
    const gl = this.gl;
    if (width !== this.maskWidth || height !== this.maskHeight) {
      this.maskWidth = Math.max(2, width);
      this.maskHeight = Math.max(2, height);
      this.maskCurrentTex = this.createMaskTexture(this.maskWidth, this.maskHeight, this.maskCurrentTex);
      this.maskPreviousTex = this.createMaskTexture(this.maskWidth, this.maskHeight, this.maskPreviousTex);
      this.maskSmoothTex = this.createMaskTexture(this.maskWidth, this.maskHeight, this.maskSmoothTex);
      this.maskFeatherTex = this.createMaskTexture(this.maskWidth, this.maskHeight, this.maskFeatherTex);
    }

    gl.bindTexture(gl.TEXTURE_2D, this.maskCurrentTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.maskWidth, this.maskHeight, 0, gl.RED, gl.UNSIGNED_BYTE, maskData);

    gl.bindTexture(gl.TEXTURE_2D, this.maskPreviousTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.maskWidth, this.maskHeight, 0, gl.RED, gl.UNSIGNED_BYTE, maskData);

    gl.bindTexture(gl.TEXTURE_2D, null);

    this.maskReady = true;
  }

  setBackgroundImage(bitmap: ImageBitmap | null): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
    if (bitmap) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      this.backgroundAspect = bitmap.width / Math.max(1, bitmap.height);
    } else {
      this.fillBackgroundFallback();
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  setFaceBox(box: FaceBox | null): void {
    this.faceBox = box;
  }

  render(bitmap: ImageBitmap, options: WebGLCompositorRenderOptions): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (!this.maskReady || options.effect === 'none') {
      this.drawCopy(this.videoTexture);
      return;
    }

    this.runTemporalSmooth();
    this.runEdgeFeather();
    this.runBlurPass(options.effect, options.blurStrength);
    this.runLightWrapping();
    this.runFaceCorrection();
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.copyProgram);
    gl.deleteProgram(this.temporalProgram);
    gl.deleteProgram(this.edgeProgram);
    gl.deleteProgram(this.blurProgram);
    gl.deleteProgram(this.lightProgram);
    gl.deleteProgram(this.faceProgram);
    gl.deleteFramebuffer(this.maskFramebuffer);
    gl.deleteFramebuffer(this.blurFramebuffer);
    gl.deleteFramebuffer(this.lightFramebuffer);
    gl.deleteTexture(this.videoTexture);
    gl.deleteTexture(this.backgroundTexture);
    gl.deleteTexture(this.maskCurrentTex);
    gl.deleteTexture(this.maskPreviousTex);
    gl.deleteTexture(this.maskSmoothTex);
    gl.deleteTexture(this.maskFeatherTex);
    gl.deleteTexture(this.blurTexture);
    gl.deleteTexture(this.lightTexture);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteVertexArray(this.vao);
  }

  private runTemporalSmooth(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.maskSmoothTex, 0);
    gl.viewport(0, 0, this.maskWidth, this.maskHeight);
    gl.useProgram(this.temporalProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.maskCurrentTex);
    gl.uniform1i(gl.getUniformLocation(this.temporalProgram, 'u_currentMask'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskPreviousTex);
    gl.uniform1i(gl.getUniformLocation(this.temporalProgram, 'u_previousMask'), 1);

    gl.uniform1f(gl.getUniformLocation(this.temporalProgram, 'u_currentWeight'), 0.75);
    gl.uniform1f(gl.getUniformLocation(this.temporalProgram, 'u_previousWeight'), 0.25);

    this.drawFullscreen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const temp = this.maskPreviousTex;
    this.maskPreviousTex = this.maskSmoothTex;
    this.maskSmoothTex = temp;
  }

  private runEdgeFeather(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.maskFeatherTex, 0);
    gl.viewport(0, 0, this.maskWidth, this.maskHeight);

    gl.useProgram(this.edgeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.maskPreviousTex);
    gl.uniform1i(gl.getUniformLocation(this.edgeProgram, 'u_mask'), 0);
    gl.uniform2f(gl.getUniformLocation(this.edgeProgram, 'u_texelSize'), 1 / this.maskWidth, 1 / this.maskHeight);
    gl.uniform1f(gl.getUniformLocation(this.edgeProgram, 'u_strength'), 2.0);

    this.drawFullscreen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private runBlurPass(effect: VirtualBackgroundEffect, blurStrength: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.blurTexture, 0);
    gl.viewport(0, 0, this.width, this.height);

    gl.useProgram(this.blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.uniform1i(gl.getUniformLocation(this.blurProgram, 'u_foreground'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
    gl.uniform1i(gl.getUniformLocation(this.blurProgram, 'u_background'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskFeatherTex);
    gl.uniform1i(gl.getUniformLocation(this.blurProgram, 'u_mask'), 2);

    gl.uniform1f(gl.getUniformLocation(this.blurProgram, 'u_blurRadius'), blurStrength);
    gl.uniform2f(gl.getUniformLocation(this.blurProgram, 'u_texelSize'), 1 / this.width, 1 / this.height);
    gl.uniform1f(gl.getUniformLocation(this.blurProgram, 'u_useBackgroundImage'), effect === 'image' ? 1.0 : 0.0);
    gl.uniform1f(gl.getUniformLocation(this.blurProgram, 'u_bgAspect'), this.backgroundAspect);
    gl.uniform1f(gl.getUniformLocation(this.blurProgram, 'u_canvasAspect'), this.width / this.height);

    this.drawFullscreen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private runLightWrapping(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lightFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.lightTexture, 0);
    gl.viewport(0, 0, this.width, this.height);

    gl.useProgram(this.lightProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.uniform1i(gl.getUniformLocation(this.lightProgram, 'u_foreground'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blurTexture);
    gl.uniform1i(gl.getUniformLocation(this.lightProgram, 'u_blurred'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskFeatherTex);
    gl.uniform1i(gl.getUniformLocation(this.lightProgram, 'u_mask'), 2);

    gl.uniform2f(gl.getUniformLocation(this.lightProgram, 'u_texelSize'), 1 / this.width, 1 / this.height);
    gl.uniform1f(gl.getUniformLocation(this.lightProgram, 'u_wrapStrength'), 0.7);

    this.drawFullscreen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private runFaceCorrection(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);

    gl.useProgram(this.faceProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lightTexture);
    gl.uniform1i(gl.getUniformLocation(this.faceProgram, 'u_input'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskFeatherTex);
    gl.uniform1i(gl.getUniformLocation(this.faceProgram, 'u_mask'), 1);

    const box = this.faceBox ?? { x0: -1, y0: -1, x1: -1, y1: -1 };
    gl.uniform4f(gl.getUniformLocation(this.faceProgram, 'u_faceBox'), box.x0, box.y0, box.x1, box.y1);
    gl.uniform1f(gl.getUniformLocation(this.faceProgram, 'u_exposureBoost'), 0.18);
    gl.uniform1f(gl.getUniformLocation(this.faceProgram, 'u_whiteBalance'), 0.08);

    this.drawFullscreen();
  }

  private drawCopy(texture: WebGLTexture): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.copyProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(this.copyProgram, 'u_tex'), 0);
    gl.uniform1f(gl.getUniformLocation(this.copyProgram, 'u_flipY'), 1);
    this.drawFullscreen();
  }

  private drawFullscreen(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.useProgram(null);
  }

  private createVideoTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create video texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  private createBackgroundTexture(): WebGLTexture {
    const tex = this.createVideoTexture();
    return tex;
  }

  private fillBackgroundFallback(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
    const data = new Uint8Array([4, 5, 14, 255]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.backgroundAspect = 1.0;
  }

  private createMaskTexture(width: number, height: number, reuse?: WebGLTexture): WebGLTexture {
    const gl = this.gl;
    const tex = reuse ?? gl.createTexture();
    if (!tex) throw new Error('Failed to create mask texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  private createRenderTexture(width: number, height: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create render texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  private createProgram(fragmentSource: string): WebGLProgram {
    const gl = this.gl;
    const vert = this.compileShader(gl.VERTEX_SHADER, copyVert);
    const frag = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create program');
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    const ok = gl.getProgramParameter(program, gl.LINK_STATUS);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!ok) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Program link error: ${info ?? 'unknown'}`);
    }
    return program;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Failed to create shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    if (!ok) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile error: ${info ?? 'unknown'}`);
    }
    return shader;
  }

  private createGeometry(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error('Failed to create geometry');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vertexBuffer = buffer;
    return vao;
  }

  private createFramebuffer(): WebGLFramebuffer {
    const fb = this.gl.createFramebuffer();
    if (!fb) throw new Error('Failed to create framebuffer');
    return fb;
  }
}
