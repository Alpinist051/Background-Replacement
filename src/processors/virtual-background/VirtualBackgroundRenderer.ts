import copyVert from '@/shaders/virtual-background/copy.vert?raw';
import copyFrag from '@/shaders/virtual-background/copy.frag?raw';

type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

function isOffscreenCanvas(canvas: CanvasLike): canvas is OffscreenCanvas {
  return typeof (canvas as OffscreenCanvas).transferToImageBitmap === 'function';
}

export interface VirtualBackgroundRendererInit {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export class VirtualBackgroundRenderer {
  private readonly canvas: CanvasLike;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private inputTexture: WebGLTexture | null = null;
  private uTex: WebGLUniformLocation | null = null;
  private uFlipY: WebGLUniformLocation | null = null;

  private width: number;
  private height: number;

  private inputReady = false;

  constructor(canvas: CanvasLike, init: VirtualBackgroundRendererInit) {
    this.canvas = canvas;
    this.width = init.width;
    this.height = init.height;

    // Size the canvas in device pixels to avoid per-frame scaling blur.
    // For OffscreenCanvas, size must be assigned as well.
    this.canvas.width = init.width;
    this.canvas.height = init.height;
  }

  initIfNeeded(): void {
    if (this.gl) return;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
    if (!gl) {
      throw new Error('WebGL2 not available in this browser.');
    }
    this.gl = gl;

    this.program = this.createProgram(gl, copyVert, copyFrag);
    this.uTex = gl.getUniformLocation(this.program, 'u_tex');
    this.uFlipY = gl.getUniformLocation(this.program, 'u_flipY');

    this.vao = gl.createVertexArray();
    if (!this.vao) throw new Error('Failed to create VAO');
    gl.bindVertexArray(this.vao);

    // a_position is already in clip-space coords scaled by shader.
    // Provide two triangles via a single quad strip.
    const positions = new Float32Array([
      -1, -1, //
      1, -1, //
      -1, 1, //
      -1, 1, //
      1, -1, //
      1, 1, //
    ]);

    this.vertexBuffer = gl.createBuffer();
    if (!this.vertexBuffer) throw new Error('Failed to create vertex buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.inputTexture = gl.createTexture();
    if (!this.inputTexture) throw new Error('Failed to create input texture');
    gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindVertexArray(null);
    this.inputReady = false;
  }

  /**
   * Copy/render from the provided input.
   * For now this is a real-time "none" effect (no segmentation yet).
   */
  render(input: HTMLVideoElement | ImageBitmap, options?: { flipY?: boolean }): void {
    this.initIfNeeded();
    if (!this.gl || !this.program || !this.vao || !this.inputTexture) return;

    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);

    // Upload current input frame.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);
    this.inputReady = true;

    if (this.uTex) gl.uniform1i(this.uTex, 0);
    const flipY = options?.flipY ?? 1;
    if (this.uFlipY) gl.uniform1f(this.uFlipY, flipY);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindVertexArray(null);
    gl.useProgram(null);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  dispose(): void {
    if (!this.gl) return;
    const gl = this.gl;
    try {
      if (this.inputTexture) gl.deleteTexture(this.inputTexture);
      if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.program) gl.deleteProgram(this.program);
    } finally {
      this.gl = null;
      this.program = null;
      this.vao = null;
      this.vertexBuffer = null;
      this.inputTexture = null;
    }
  }

  private createProgram(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string): WebGLProgram {
    const vert = this.compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const frag = this.compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);

    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create WebGL program');
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    const ok = gl.getProgramParameter(program, gl.LINK_STATUS);
    if (!ok) {
      const info = gl.getProgramInfoLog(program) ?? 'Unknown link error';
      gl.deleteProgram(program);
      throw new Error(`WebGL program link failed: ${info}`);
    }

    // Shaders can be deleted after link.
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return program;
  }

  private compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Failed to create shader');
    gl.shaderSource(shader, src);
    gl.compileShader(shader);

    const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    if (!ok) {
      const info = gl.getShaderInfoLog(shader) ?? 'Unknown compile error';
      gl.deleteShader(shader);
      throw new Error(`WebGL shader compile failed: ${info}`);
    }
    return shader;
  }
}

