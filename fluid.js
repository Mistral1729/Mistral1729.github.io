/**
 * 2D fluid simulation code for
 * http://jamie-wong.com/2016/08/04/webgl-fluid-simulation/
 */
window.FluidSim = function(canvasId, options) {
    options = options || {};
  
    options.initVFn = options.initVFn || [
      'sin(2.0 * 3.1415 * y)',
      'sin(2.0 * 3.1415 * x)'
    ];
  
    options.initCFn = options.initCFn || [
      'step(1.0, mod(floor((x + 1.0) / 0.2) + floor((y + 1.0) / 0.2), 2.0))',
      'step(1.0, mod(floor((x + 1.0) / 0.2) + floor((y + 1.0) / 0.2), 2.0))',
      'step(1.0, mod(floor((x + 1.0) / 0.2) + floor((y + 1.0) / 0.2), 2.0))'
    ];
  
    if (options.threshold === undefined) {
      options.threshold = true;
    }
  
    if (options.advectV === undefined) {
      options.advectV = true;
    }
  
    if (options.applyPressure === undefined) {
      options.applyPressure = false;
    }
  
    if (options.showArrows === undefined) {
      options.showArrows = true;
    }
  
    if (options.dyeSpots === undefined) {
      options.dyeSpots = false;
    }
  
    // For silly reasons, these have to be equal for now.
    // This is because I assumed grid spacing was equal along
    // each axis, so if you want to change these to not be equal, you'd have to
    // carefully go through the code and decide which values of EPSILON should be
    // 1/WIDTH, and which should be 1/HEIGHT.
    var WIDTH = options.size || 400;
    var HEIGHT = WIDTH;
    var EPSILON = 1/WIDTH;
  
    // We assume every time step will be a 120th of a second.
    // The animation loop runs at 60 fps (hopefully), so we're simulating 2x
    // slow-mo.
    var DELTA_T = 1/120.0;
  
    // We arbitrarily set our fluid's density to 1 (this is rho in equations)
    var DENSITY = 1.0;
  
    var canvas = document.getElementById(canvasId);
    canvas.style.margin = "0 auto";
    canvas.style.display = "block";
  
    var gl = GL.create(canvas);
    gl.canvas.width = WIDTH;
    gl.canvas.height = HEIGHT;
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  
    // Standard 2-triangle mesh covering the viewport
    // when draw with gl.TRIANGLE_STRIP
    var standardMesh = gl.Mesh.load({
      vertices: [
        [-1, 1],
        [1, 1],
        [-1, -1],
        [1, -1]
      ],
      coords: [
        [0, 1],
        [1, 1],
        [0, 0],
        [1, 0]
      ]
    });
  
    var standardVertexShaderSrc = '\
      varying vec2 textureCoord;\
      void main() {\
        textureCoord = gl_TexCoord.xy;\
        gl_Position = gl_Vertex;\
      }';
  
    // Given a texture holding a 2D velocity field, draw arrows
    // showing the direction of the fluid flow.
    var drawVectorFieldArrows = (function() {
      var shader = new gl.Shader('\
        mat2 rot(float angle) { \
          float c = cos(angle); \
          float s = sin(angle); \
          \
          return mat2( \
            vec2(c, -s), \
            vec2(s, c) \
          ); \
        } \
        \
        attribute vec2 position; \
        uniform sampler2D velocity; \
        void main() { \
          vec2 v = texture2D(velocity, (position + 1.0) / 2.0).xy; \
          float scale = 0.05 * length(v); \
          float angle = atan(v.y, v.x); \
          mat2 rotation = rot(-angle); \
          gl_Position = vec4( \
            (rotation * (scale * gl_Vertex.xy)) + position, \
            0.0, 1.0); \
        } \
      ', '\
        void main() { \
          gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); \
        } \
      ');
      
      // Triangle pointing towards positive x axis
      // with baseline on the y axis
      var triangleVertices = [
        [0, 0.2],
        [1, 0],
        [0, -0.2]
      ];
  
      var arrowsMesh = new gl.Mesh({triangles: false});
      arrowsMesh.addVertexBuffer('positions', 'position');
      
      var INTERVAL = 30;
      
      for (var i = INTERVAL / 2; i < HEIGHT; i += INTERVAL) {
        for (var j = INTERVAL / 2; j < WIDTH; j += INTERVAL) {
          for (var k = 0; k < 3; k++) {
            arrowsMesh.vertices.push(triangleVertices[k]);
            arrowsMesh.positions.push([2 * j / WIDTH - 1, 2 * i / HEIGHT - 1]);
          }
        }
      }
      arrowsMesh.compile();
      
      return function(velocityTexture) {
        velocityTexture.bind(0);
        shader.uniforms({
          velocity: 0
        });
        
        shader.draw(arrowsMesh, gl.TRIANGLES);    
      };
    })();
  
    // Given glsl expressions for r, g, b, a mapping (x, y) -> a value, return
    // a function that will paint a color generated by that function evaluated at
    // every pixel of the output buffer. (x, y) will be in the range
    // ([-1, 1], [-1, 1]).
    var makeFunctionPainter = function(r, g, b, a) {
      r = r || '0.0';
      g = g || '0.0';
      b = b || '0.0';
      a = a || '0.0';
  
      var shader = new gl.Shader(standardVertexShaderSrc, '\
        varying vec2 textureCoord; \
        void main() { \
          float x = 2.0 * textureCoord.x - 1.0; \
          float y = 2.0 * textureCoord.y - 1.0; \
          gl_FragColor = vec4(' + [r, g, b, a].join(',') +'); \
        } \
      ');
  
      return function() {
        shader.draw(standardMesh, gl.TRIANGLE_STRIP);
      };
    };
  
    var drawBlack = makeFunctionPainter('0.0', '0.0', '0.0', '1.0');
  
    // Draw a texture directly to the framebuffer.
    // Will stretch to fit, but in practice the texture and the framebuffer should be
    // the same size.
    var drawTexture = (function() {
      var shader = new gl.Shader(standardVertexShaderSrc, '\
        varying vec2 textureCoord; \
        uniform sampler2D inputTexture; \
        void main() { \
          gl_FragColor = texture2D(inputTexture, textureCoord); \
        } \
      ');
      
      return function(inputTexture) {
        inputTexture.bind(0);
        shader.uniforms({
          input: 0
        });
        shader.draw(standardMesh, gl.TRIANGLE_STRIP)
      };
    })();
  
    // Draw a texture to the framebuffer, thresholding at 0.5
    var drawTextureThreshold = (function() {
      var shader = new gl.Shader(standardVertexShaderSrc, '\
        varying vec2 textureCoord; \
        uniform sampler2D inputTexture; \
        void main() { \
          gl_FragColor = step(0.5, texture2D(inputTexture, textureCoord)); \
        } \
      ');
  
      return function(inputTexture) {
        inputTexture.bind(0);
        shader.uniforms({
          input: 0
        });
        shader.draw(standardMesh, gl.TRIANGLE_STRIP)
      };  
    })();
  
    // Given an velocity texture and a time delta, advect the
    // quantities in the input texture into the output texture
    var advect = (function() {
      var shader = new gl.Shader(standardVertexShaderSrc, '\
        uniform float deltaT; \
        uniform sampler2D inputTexture; \
        uniform sampler2D velocity; \
        varying vec2 textureCoord; \
        \
        void main() { \
          vec2 u = texture2D(velocity, textureCoord).xy; \
          \
          vec2 pastCoord = fract(textureCoord - (0.5 * deltaT * u)); \
          gl_FragColor = texture2D(inputTexture, pastCoord); \
        } \
      ');
  
      return function(inputTexture, velocityTexture) {
        inputTexture.bind(0);
        velocityTexture.bind(1);
  
        shader.uniforms({
          deltaT: DELTA_T,
          input: 0,
          velocity: 1
        });
        shader.draw(standardMesh, gl.TRIANGLE_STRIP);
      };
    })();
  
    // Apply a "splat" of change to a given place with a given
    // blob radius. The effect of the splat has an exponential falloff.
    var addSplat = (function() {
      var shader = new gl.Shader(standardVertexShaderSrc, '\
        uniform vec4 change; \
        uniform vec2 center; \
        uniform float radius; \
        uniform sampler2D inputTex; \
        \
        varying vec2 textureCoord; \
        \
        void main() { \
          float dx = center.x - textureCoord.x; \
          float dy = center.y - textureCoord.y; \
          vec4 cur = texture2D(inputTex, textureCoord); \
          gl_FragColor = cur + change * exp(-(dx * dx + dy * dy) / radius); \
        } \
      ');
  
      return function(inputTexture, change, center, radius) {
        inputTexture.bind(0);
        shader.uniforms({
          change: change,
          center: center,
          radius: radius,
          inputTex: 0
        });
        shader.draw(standardMesh, gl.TRIANGLE_STRIP);
      };
    })();
  
    // Make sure all the color components are between 0 and 1
    var clampColors = (function() {
      var shader = new gl.Shader(standardVertexShaderSrc, '\
        uniform sampler2D inputTex; \
        varying vec2 textureCoord; \
        \
        void main() { \
          gl_FragColor = clamp(texture2D(inputTex, textureCoord), 0.0, 1.0); \
        } \
      ');
  
      return function(inputTexture) {
        inputTexture.bind(0);
        shader.uniforms({
          inputTex: 0
        });
        shader.draw(standardMesh, gl.TRIANGLE_STRIP);
      };
    })();
  
    // Calculate the divergence of the advected velocity field, and multiply by
    // (2 * epsilon * rho / deltaT).
    var calcDivergence = (function() {
      var shader = new gl.Shader(standardVertexShaderSrc, '\
        uniform float deltaT;         // Time between steps \n\
        uniform float rho;            // Density \n\
        uniform float epsilon;        // Distance between grid units \n\
        uniform sampler2D velocity;   // Advected velocity field, u_a \n\
        \
        varying vec2 textureCoord; \
        \
        vec2 u(vec2 coord) { \
          return texture2D(velocity, fract(coord)).xy; \
        } \
        \
        void main() { \
          gl_FragColor = vec4((-2.0 * epsilon * rho / deltaT) * ( \
            (u(textureCoord + vec2(epsilon, 0)).x - \
             u(textureCoord - vec2(epsilon, 0)).x) \
            + \
            (u(textureCoord + vec2(0, epsilon)).y - \
             u(textureCoord - vec2(0, epsilon)).y) \
          ), 0.0, 0.0, 1.0); \
        } \
      ');
  
      return function(velocityTexture) {
        velocityTexture.bind(0);
        shader.uniforms({
          velocity: 0,
          epsilon: EPSILON,
          deltaT: DELTA_T,
          rho: DENSITY
        });
        shader.draw(standardMesh, gl.TRIANGLE_STRIP);
      };
    })();
  
    // Perform a single iteration of the Jacobi method in order to solve for
    // pressure.
    var jacobiIterationForPressure = (function() {
      var shader = new gl.Shader(standardVertexShaderSrc, '\
        uniform float epsilon;        // Distance between grid units \n\
        uniform sampler2D divergence; // Divergence field of advected velocity, d \n\
        uniform sampler2D pressure;   // Pressure field from previous iteration, p^(k-1) \n\
        \
        varying vec2 textureCoord; \
        \
        float d(vec2 coord) { \
          return texture2D(divergence, fract(coord)).x; \
        } \
        \
        float p(vec2 coord) { \
          return texture2D(pressure, fract(coord)).x; \
        } \
        \
        void main() { \
          gl_FragColor = vec4(0.25 * ( \
            d(textureCoord) \
            + p(textureCoord + vec2(2.0 * epsilon, 0.0)) \
            + p(textureCoord - vec2(2.0 * epsilon, 0.0)) \
            + p(textureCoord + vec2(0.0, 2.0 * epsilon)) \
            + p(textureCoord - vec2(0.0, 2.0 * epsilon)) \
          ), 0.0, 0.0, 1.0); \
        } \
      ');
  
      return function(divergenceTexture, pressureTexture) {
        divergenceTexture.bind(0);
        pressureTexture.bind(1);
        shader.uniforms({
          divergence: 0,
          pressure: 1,
          epsilon: EPSILON
        });
        shader.draw(standardMesh, gl.TRIANGLE_STRIP);
      };
    })();
  
    // Subtract the pressure gradient times a constant from the advected velocity
    // field.
    var subtractPressureGradient = (function() {
      var shader = new gl.Shader(standardVertexShaderSrc, '\
        uniform float deltaT;         // Time between steps \n\
        uniform float rho;            // Density \n\
        uniform float epsilon;        // Distance between grid units \n\
        uniform sampler2D velocity;   // Advected velocity field, u_a \n\
        uniform sampler2D pressure;   // Solved pressure field \n\
        \
        varying vec2 textureCoord; \
        \
        float p(vec2 coord) { \
          return texture2D(pressure, fract(coord)).x; \
        } \
        \
        void main() { \
          vec2 u_a = texture2D(velocity, textureCoord).xy; \
          \
          float diff_p_x = (p(textureCoord + vec2(epsilon, 0.0)) - \
                            p(textureCoord - vec2(epsilon, 0.0))); \
          float u_x = u_a.x - deltaT/(2.0 * rho * epsilon) * diff_p_x; \
          \
          float diff_p_y = (p(textureCoord + vec2(0.0, epsilon)) - \
                            p(textureCoord - vec2(0.0, epsilon))); \
          float u_y = u_a.y - deltaT/(2.0 * rho * epsilon) * diff_p_y; \
          \
          gl_FragColor = vec4(u_x, u_y, 0.0, 0.0); \
        } \
      ');
  
      return function(velocityTexture, pressureTexture) {
        velocityTexture.bind(0);
        pressureTexture.bind(1);
        shader.uniforms({
          velocity: 0,
          pressure: 1,
          epsilon: EPSILON,
          deltaT: DELTA_T,
          rho: DENSITY
        });
        shader.draw(standardMesh, gl.TRIANGLE_STRIP);
      };
    })();
  
    var makeTextures = function(names) {
      var ret = {};
      names.forEach(function(name) {
        ret[name] = new gl.Texture(WIDTH, HEIGHT, {type: gl.FLOAT});
      });
  
      ret.swap = function(a, b) {
        var temp = ret[a];
        ret[a] = ret[b];
        ret[b] = temp;
      };
  
      return ret;
    };
  
    var textures = makeTextures([
      'velocity0',
      'velocity1',
      'color0',
      'color1',
      'divergence',
      'pressure0',
      'pressure1'
    ]);
  
    var initVFnPainter = makeFunctionPainter(options.initVFn[0],
                                             options.initVFn[1]);
    var initCFnPainter = makeFunctionPainter(options.initCFn[0],
                                             options.initCFn[1],
                                             options.initCFn[2]);
  
    var reset = function() {
      textures.velocity0.drawTo(initVFnPainter);
      textures.color0.drawTo(initCFnPainter);
      textures.pressure0.drawTo(drawBlack);
    };
  
    reset();
  
    // Reset the simulation on double click
    canvas.addEventListener('dblclick', reset);
  
    // Returns true if the canvas is on the screen
    // If "middleIn" is true, then will only return true if the middle of the
    // canvas is within the scroll window.
    var onScreen = function(middleIn) {
      var container = canvas.offsetParent;
  
      var canvasBottom = canvas.offsetTop + canvas.height;
      var canvasTop = canvas.offsetTop;
  
      var containerTop = window.scrollY;
      var containerBottom = window.scrollY + window.innerHeight;
  
      if (middleIn) {
        return (containerTop < (canvasTop + canvasBottom) / 2 &&
                (canvasTop + canvasBottom) / 2 < containerBottom);
      } else {
        return (containerTop < canvasBottom && containerBottom > canvasTop);
      }
    };
  
    gl.ondraw = function() {
      // If the canvas isn't visible, don't draw it
      if (!onScreen()) return;
  
      gl.clearColor(1.0, 1.0, 1.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (options.threshold) {
        drawTextureThreshold(textures.color0);
      } else {
        drawTexture(textures.color0);
      }
  
      if (options.showArrows) {
        drawVectorFieldArrows(textures.velocity0);
      }
    };
  
    gl.onupdate = function() {
      // If the canvas isn't fully on-screen, don't run the simulation
      if (!onScreen(true)) return;
  
      if (options.advectV) {
        // Advect the velocity texture through itself, leaving the result in
        // textures.velocity0
        textures.velocity1.drawTo(function() {
          advect(textures.velocity0, textures.velocity0);
        });
        textures.swap('velocity0', 'velocity1');
      }
  
      if (options.applyPressure) {
        // Calculate the divergence, leaving the result in textures.divergence
        textures.divergence.drawTo(function() {
          calcDivergence(textures.velocity0);
        });
  
        // Calculate the pressure, leaving the result in textures.pressure0
        var JACOBI_ITERATIONS = 10;
  
        for (var i = 0; i < JACOBI_ITERATIONS; i++) {
          textures.pressure1.drawTo(function() {
            jacobiIterationForPressure(textures.divergence, textures.pressure0);
          });
          textures.swap('pressure0', 'pressure1');
        }
  
        // Subtract the pressure gradient from the advected velocity texture,
        // leaving the result in textures.velocity0
        textures.velocity1.drawTo(function() {
          subtractPressureGradient(textures.velocity0, textures.pressure0);
        });
        textures.swap('velocity0', 'velocity1');
      }
  
      // Advect the color field, leaving the result in textures.color0
      textures.color1.drawTo(function() {
        advect(textures.color0, textures.velocity0);
      });
      textures.swap('color0', 'color1');
  
      if (options.dyeSpots) {
        // Add a few spots slowly emitting dye to prevent the color from
        // eventually converging to the grey-ish average color of the whole fluid
        var addDyeSource = function(color, location) {
          textures.color1.drawTo(function() {
            addSplat(
              textures.color0,
              color.concat([0.0]),
              location,
              0.01
            );
          });
          textures.swap('color0', 'color1');
        };
  
        // Add red to bottom left
        addDyeSource([0.004, -0.002, -0.002], [0.2, 0.2]);
  
        // Add blue to the top middle
        addDyeSource([-0.002, -0.002, 0.004], [0.5, 0.9]);
  
        // Add green to the bottom right
        addDyeSource([-0.002, 0.004, -0.002], [0.8, 0.2]);
      }
    };
  
    gl.onmousemove = function(ev) {
      if (ev.dragging) {
        textures.velocity1.drawTo(function() {
          addSplat(
            textures.velocity0,
            [10.0 * ev.deltaX / WIDTH, -10.0 * ev.deltaY / HEIGHT, 0.0, 0.0],
            [ev.offsetX / WIDTH, 1.0 - ev.offsetY / HEIGHT],
            0.01
          );
        });
        textures.swap('velocity0', 'velocity1');
      }
    };
  
    gl.animate();
  };