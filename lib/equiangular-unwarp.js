/**
* Javascript object to unwarp a warped video image captured from an
* equiangular panoramic mirror, like the GoPano Plus, in real-time
* using WebGL.
*
* @author Gregory W Bond
*/

// Requires three.js and webgl-utils libs

// Constructor args are a 16x9 video element with warped video source and a canvas element 
// onto which unwarped video will be displayed
EquiangularUnwarp = function( warpedVideo, renderCanvas ) {
	
	var warpedVideo = warpedVideo;
	var renderCanvas = renderCanvas;

	// BEGIN PUBLIC VARIABLES

	// mirror parameters

	var mirrorFieldOfView = new Object();
	// mirror vertical field of view in degrees
	mirrorFieldOfView.lowerLimit = -58.0;
	mirrorFieldOfView.range = 110.0;

	// warped image parameters

	var warpedImageCenter = new Object();
	// normalized coords of warped image center on source image in x
	// and y directions
	warpedImageCenter.x = 0.495;
	warpedImageCenter.y = 0.50;

	var warpedImageRadius = new Object();
	// ratio of warped image radius relative to source image length in
	// x and y directions - radius extends from warped image center
	// (point corresponding to bottom of mirror) to warped image outer
	// edge (point corresponding to mirror's top edge)
	warpedImageRadius.x = 0.25;
	warpedImageRadius.y = 0.45;

	// horizontal orientation of unwarped image view - mirror image:
	// -1.0, or normal: 1.0
	var unwarpedImageHorizontalScale = 1.0;

	// END PUBLIC VARIABLES

	var camera, scene, sphereMaterial, renderer, sphereTexture, instructionsSprite, instructionsTexture, instructionsMaterial;
	var sphereRadius = 500; // radius of sphere geometry onto which the unwarped image is projected - must be a multiple of 10

	// view params
	var viewRotation; // current view rotation matrix
	var fieldOfView = new Object(); // current vertical view FOV (zoom) in degrees
	var viewTilt = new Object(); // current camera tilt angle, and max camera tilt up/down for current field of view, in degrees
	var viewPan = new Object(); // current camera pan angle, in degrees

	// UI params
	var stopAnimation = false; // unwarp animation loop active when set - set to true when start() called, and set to false when stop() called
	var displayingInstructions = false; // true when user interaction instructions are being displayed, o.w. false
	var initialInteractionOccurred = false; // set to true first time user interacts with this page with the mouse
	var isUserInteracting = false; // set to true while the mouse button is down
	var transitionSequenceOccurring = false; // set to true after initial interaction occurs - reset to false after transition sequence completed
	var cameraOrbitRadius = 900; // radius around center of sphere at which camera orbits in XZ plane prior to user interaction - must be a multiple of 10
	var cameraOrbitPosition = 0; // current camera position in degrees in XZ plane as it orbits the sphere prior to user interaction
	var onMouseDownMouseX = 0;
	var onMouseDownMouseY = 0;
	var deltaLon = 0.0, onMouseDownLon = 0;
	var deltaLat = 0.0, onMouseDownLat = 0;
	var deltaFov = 0.0;
	var instructionsDisplayState = "INVISIBLE"; // signifies current instruction display state when user interaction instructions are being displayed
	var instructionFadeTimeFrames = 30; // instruction fade in/out time in frames
	var instructionCurrentFadeTimeFrames = 0; // current number of frames during instruction fade in/out

	mirrorFieldOfView.upperLimit = mirrorFieldOfView.range + mirrorFieldOfView.lowerLimit;

	// initialize view parameters
	fieldOfView.current = 75.0; // initial camera vertical field of view in degrees
	fieldOfView.max = Math.min( Math.abs( mirrorFieldOfView.lowerLimit ), mirrorFieldOfView.upperLimit ) * 2.0; // max field of view when camera pointed at the equator - limit on zooming out
	fieldOfView.min = 10.0; // limit on zooming in
	viewTilt.current = 0; // initial camera tilt in degrees for current vertical field of view - camera pointed at the equator
	updateTiltLimits(); // set max permissible tilt up/down in degrees for current view vfov and mirror vfov
	viewPan.current = 0; // initial camera pan angle in degrees - camera pointed due "north" on warped image

	renderCanvas.addEventListener( 'mousedown', initialRenderCanvasMouseEventHandler, false );
	renderCanvas.addEventListener( 'mousemove', initialRenderCanvasMouseEventHandler, false );
	renderCanvas.addEventListener( 'mouseup', initialRenderCanvasMouseEventHandler, false );
	renderCanvas.addEventListener( 'mousewheel', initialRenderCanvasMouseEventHandler, false );
	renderCanvas.addEventListener( 'DOMMouseScroll', initialRenderCanvasMouseEventHandler, false);

	camera = new THREE.PerspectiveCamera( fieldOfView.current, renderCanvas.width / renderCanvas.height, 1, sphereRadius + cameraOrbitRadius );
	camera.position.z = cameraOrbitRadius;
	camera.target = new THREE.Vector3( 0, 0, 0 );
	camera.lookAt( camera.target );

	scene = new THREE.Scene();

	var sphereGeometry = createSphereGeometry(); // create sphere onto which unwarped image is projected
	sphereTexture = new THREE.Texture( warpedVideo ); // create a texture from the warped video
	sphereMaterial = createSphereMaterial( sphereTexture ); // create material from warped video texture to apply to inside of sphere
	var sphereMesh = new THREE.Mesh( sphereGeometry, sphereMaterial ); // apply material to sphere geometry
	sphereMesh.scale.x = unwarpedImageHorizontalScale;
	
	scene.add( sphereMesh );

	instructionsTexture = THREE.ImageUtils.loadTexture( "resources/UserInstructions.png" , undefined, function () { console.log("instructions image loaded"); }, function () { console.log("instructions image not loaded"); } );

	renderer = new THREE.WebGLRenderer( { canvas: renderCanvas, preserveDrawingBuffer: true } );
	renderer.setSize( renderCanvas.width, renderCanvas.height );

	// create vertices, UV map and normals for portion of a sphere corresponding to mirror 
	// range: a full 360 degrees of longitude, and latitude above and below equator 
	// limited by the mirror's vertical field of view - basically a sphere with its 
	// polar caps missing - sphere tessalation based on lesson 11 of "learning webgl"
	function createSphereGeometry() {

		var sphereLatitudeBands = 90; // number of latitudinal divisions of the sphere
		var sphereLongitudeBands = 90; // number of longitudinal divisions of the sphere 

		// min and max latitude band numbers relative to north pole
		var minLatitudeBand = Math.ceil( ( 90 - mirrorFieldOfView.upperLimit ) * ( sphereLatitudeBands / 180 ) );
		var maxLatitudeBand = Math.floor( ( 90 - mirrorFieldOfView.lowerLimit ) * ( sphereLatitudeBands / 180 ) );
		var latitudeBands = maxLatitudeBand - minLatitudeBand;
		var longitudeBands = sphereLongitudeBands;

		var numTriangles = ( latitudeBands + 1 ) * ( longitudeBands + 1 ); // final vertices overlap initial vertices in order to close the sphere

		var vertexPositionData = new Float32Array( numTriangles * 3 ); // 3 coords per vertex
		var textureCoordData = new Float32Array( numTriangles * 2 ); // 2 coords per vertex
		var normalCoordData = new Float32Array( numTriangles * 3 ); // 3 coords per vertex
		var vertexPositionCount = 0;
		var textureCoordCount = 0;
		var normalCoordCount = 0;
		var vertexNum = 0;

		for ( var latNumber = minLatitudeBand; latNumber <= maxLatitudeBand; latNumber++ ) {

			var theta = latNumber * Math.PI / sphereLatitudeBands;
			var sinTheta = Math.sin( theta );
			var cosTheta = Math.cos( theta );

			for ( var longNumber = 0; longNumber <= longitudeBands; longNumber++ ) {

				var phi = longNumber * 2 * Math.PI / longitudeBands;
				var sinPhi = Math.sin( phi );
				var cosPhi = Math.cos( phi );

				var z = cosPhi * sinTheta;
				var y = cosTheta;
				var x = sinPhi * sinTheta;

				normalCoordData[ normalCoordCount++ ] = x; 
				normalCoordData[ normalCoordCount++ ] = y;
				normalCoordData[ normalCoordCount++ ] = z;

				vertexPositionData[ vertexPositionCount++ ] = sphereRadius * x;
				vertexPositionData[ vertexPositionCount++ ] = sphereRadius * y;
				vertexPositionData[ vertexPositionCount++ ] = sphereRadius * z;

				//console.log("lat: " + latNumber + " long: " + longNumber + " index: " + vertexNum + ": " + vertexPositionData[ vertexPositionCount-3 ] + " " + vertexPositionData[ vertexPositionCount-2 ] + " " + vertexPositionData[ vertexPositionCount-1 ] );
				vertexNum++;

				// input point from position
				var r = ( ( Math.PI / 2.0 ) + Math.asin( y ) ) / ( THREE.Math.degToRad( mirrorFieldOfView.range ) + ( Math.PI / 2.0 ) + THREE.Math.degToRad( mirrorFieldOfView.lowerLimit ) ); // maps latitude on sphere to a point between 0 and 1 relative to the mirror's maximum vertical range

				var hyp = Math.sqrt( Math.pow( x, 2.0 ) + Math.pow( z, 2.0 ) ); // spherical (x,z) identifies a radius with slope z/x on input image - compute length of hypotenuse identified by (x,z)
				var u, v;
				// compute UV coords so that warped mirror image is unwarped when mapped to sphere
				u = ( x / hyp ) * r; // multiply normalized latitude times cosine of input image radius angle to obtain normalized x ordinate of latitude on input image
				v = ( z / hyp ) * r; // multiply normalized latitude times sine of input image radius angle to obtain normalized y ordinate of latitude on input image
				u = ( u * warpedImageRadius.x ) + warpedImageCenter.x; // adjust x coord relative to mirror image position on normalized input image
				v = ( v * warpedImageRadius.y ) + warpedImageCenter.y; // adjust y coord relative to mirror image position on normalized input image

				textureCoordData[ textureCoordCount++ ] = u;
				textureCoordData[ textureCoordCount++ ] = v;
			}
		}

		var numIndices = longitudeBands * latitudeBands * 6; // each rectangle consists of two triangles of 3 vertices each
		var indexData = new Int16Array( numIndices );
		var indexCount = 0;
		var rectangleNum = 0;

		for ( var latNumber = 0; latNumber < latitudeBands; latNumber++ ) {

			for ( var longNumber = 0; longNumber < longitudeBands; longNumber++ ) {

				var first = ( latNumber * ( longitudeBands + 1 ) ) + longNumber;
				var second = first + longitudeBands + 1;

				indexData[ indexCount++ ] = first;
				indexData[ indexCount++ ] = second;
				indexData[ indexCount++ ] = first + 1;

				indexData[ indexCount++ ] = second;
				indexData[ indexCount++ ] = second + 1;
				indexData[ indexCount++ ] = first + 1;

				//console.log("rectangle: " + rectangleNum + " triangle: 1 indices: " + indexData[ indexCount-6 ] + ", " +  indexData[ indexCount-5 ] + ", " +  indexData[ indexCount-4 ]);
				//console.log("rectangle: " + rectangleNum + " triangle: 2 indices: " + indexData[ indexCount-3 ] + ", " +  indexData[ indexCount-2 ] + ", " +  indexData[ indexCount-1 ]);
				rectangleNum++;
			}
		}

		var geometry = new THREE.BufferGeometry();
		geometry.attributes = {
			index: {
				itemSize: 1,
				array: indexData,
				numItems: indexCount
			},
			position: {
				itemSize: 3,
				array: vertexPositionData,
				numItems: vertexPositionCount / 3
			},
			uv: {
				itemSize: 2,
				array: textureCoordData,
				numItems: textureCoordCount / 2
			},
			normal: {
				itemSize: 3,
				array: normalCoordData,
				numItems: normalCoordCount / 3
			}
		};

		// index offsets are required for BufferGeometry but no chunking required
		// if numIndices < 65K
		geometry.offsets.push( { start: 0, count: numIndices, index: 0 } );

		return geometry;
	}

	function createSphereMaterial( sphereTexture ) {

		sphereTexture.minFilter = THREE.LinearFilter;
		sphereTexture.magFilter = THREE.LinearFilter;
		// assumes edge clamping if wrap params undefined
		sphereTexture.format = THREE.RGBFormat;
		sphereTexture.generateMipmaps = false;
		sphereTexture.needsUpdate = true;

		var material = new THREE.MeshBasicMaterial( { map: sphereTexture, side: THREE.BackSide } );

		return material;
	}

	// this handler is invoked the first time a mouse event is 
	// detected in the renderCanvas
	function initialRenderCanvasMouseEventHandler( event ) {

		event.preventDefault();
		// remove mouse handlers while camera transition occurs
		renderCanvas.removeEventListener( 'mousedown', initialRenderCanvasMouseEventHandler, false );
		renderCanvas.removeEventListener( 'mousemove', initialRenderCanvasMouseEventHandler, false );
		renderCanvas.removeEventListener( 'mouseup', initialRenderCanvasMouseEventHandler, false );
		renderCanvas.removeEventListener( 'mousewheel', initialRenderCanvasMouseEventHandler, false );
		renderCanvas.removeEventListener( 'DOMMouseScroll', initialRenderCanvasMouseEventHandler, false);

		// set flag to initiate transition sequence that moves camera into 
		// center of unwarped image sphere
		transitionSequenceOccurring = true;

		// set flag indicating that initial user interaction has occurred
		initialInteractionOccurred = true;
	}

	function onRenderCanvasMouseDown( event ) {

		event.preventDefault();

		isUserInteracting = true;

		onPointerDownPointerX = event.clientX;
		onPointerDownPointerY = event.clientY;

		deltaLon = 0;
		deltaLat = 0;
	}

	function onRenderCanvasMouseMove( event ) {

		if ( isUserInteracting ) {
			deltaLon = ( event.clientX - onPointerDownPointerX ) * 0.005;
			deltaLat = ( event.clientY - onPointerDownPointerY ) * 0.005;
		}
	}

	function onRenderCanvasMouseUp( event ) {

		isUserInteracting = false;
	}

	function onRenderCanvasMouseWheel( event ) {

		event.preventDefault();

		if ( event.wheelDeltaY ) {
			// WebKit
			deltaFov -= event.wheelDeltaY * 0.05;
		} else if ( event.wheelDelta ) {
			// Opera / Explorer 9
			deltaFov -= event.wheelDelta * 0.05;
		} else if ( event.detail ) {
			// Firefox
			deltaFov += event.detail * 1.0;
		}
	}


	// set max permissible tilt up/down in degrees for current view
	// vfov and mirror vfov
	function updateTiltLimits() {

		var halfFov = fieldOfView.current / 2.0;
		viewTilt.upLimit = mirrorFieldOfView.upperLimit - halfFov;
		viewTilt.downLimit = mirrorFieldOfView.lowerLimit + halfFov;
		console.log("viewTilt.upLimit: " + viewTilt.upLimit);
		console.log("viewTilt.downLimit: " + viewTilt.downLimit);
	}

	function updateView() {

		if ( ! initialInteractionOccurred ) {

			// if no initial user interaction has occurred with the
			// mouse, then slowly orbit around the unwarped image sphere

			cameraOrbitPosition = ( cameraOrbitPosition + 0.5 ) % 360.0;
			camera.position.x = Math.cos( THREE.Math.degToRad( cameraOrbitPosition ) ) * cameraOrbitRadius;
			camera.position.z = Math.sin( THREE.Math.degToRad( cameraOrbitPosition ) ) * cameraOrbitRadius;
			camera.lookAt( camera.target );

		} else if ( transitionSequenceOccurring ) {

			// incrementally move camera along current XZ plane radius 
			// towards center of unwarped image sphere
			cameraOrbitRadius -= 10;

			if ( cameraOrbitRadius == 0 ) {

				// transition sequence is complete when camera arrives at center of 
				// unwarped image sphere
				
				camera.position.x = 0;
				camera.position.z = 0;

				// now camera is on the inside of the sphere looking out instead of 
				// on the outside looking in
				viewPan.current = ( 180 + cameraOrbitPosition ) % 360;
				camera.target.x = Math.cos( THREE.Math.degToRad( viewPan.current ) ) * sphereRadius;
				camera.target.z = Math.sin( THREE.Math.degToRad( viewPan.current ) ) * sphereRadius;				

				// console.log("cameraOrbitPosition = " + cameraOrbitPosition );
				// console.log("viewPan.current: " + viewPan.current );
				// console.log("position (x,y,z) = " + camera.position.x + ", " + camera.position.y + ", " + camera.position.z );
				// console.log("target (x,y,z) = " + camera.target.x + ", " + camera.target.y + ", " + camera.target.z );

				transitionSequenceOccurring = false;
				displayingInstructions = true;

				// install mouse handlers for all subsequent mouse interaction
				renderCanvas.addEventListener( 'mousedown', onRenderCanvasMouseDown, false );
				renderCanvas.addEventListener( 'mousemove', onRenderCanvasMouseMove, false );
				renderCanvas.addEventListener( 'mouseup', onRenderCanvasMouseUp, false );
				renderCanvas.addEventListener( 'mousewheel', onRenderCanvasMouseWheel, false );
				renderCanvas.addEventListener( 'DOMMouseScroll', onRenderCanvasMouseWheel, false );

			} else {

				camera.position.x = Math.cos( THREE.Math.degToRad( cameraOrbitPosition ) ) * cameraOrbitRadius;
				camera.position.z = Math.sin( THREE.Math.degToRad( cameraOrbitPosition ) ) * cameraOrbitRadius;				
			}

			camera.lookAt( camera.target );

		} else if ( displayingInstructions ) {
			
			// display instructions as a sprite
			if ( instructionsDisplayState == "INVISIBLE" ) {

				instructionsMaterial = new THREE.SpriteMaterial( { map: instructionsTexture, alignment: THREE.SpriteAlignment.center, opacity: 0 } ); // instructions are initially invisible

				instructionsSprite = new THREE.Sprite( instructionsMaterial );
				instructionsSprite.position.set( renderCanvas.width / 2, renderCanvas.height / 2, 0 ); // position instructions in center of scene
				instructionsSprite.scale.set( instructionsTexture.image.width, instructionsTexture.image.height, 1 );
				scene.add( instructionsSprite );
				//console.log("added instructions to scene - fading in...");
				
				instructionsDisplayState = "FADING_IN";

			} else if ( instructionsDisplayState == "FADING_IN" ) {
				
				// fade in instructions
				if ( instructionCurrentFadeTimeFrames < instructionFadeTimeFrames ) {

					instructionCurrentFadeTimeFrames++;
					instructionsMaterial.opacity +=  1 / instructionFadeTimeFrames; // incrementally increase visibility

				} else {
					
					//console.log("instruction fade in complete");

					instructionCurrentFadeTimeFrames = 0;
					instructionsDisplayState = "VISIBLE";					
				}				
			} else if ( isUserInteracting || deltaFov != 0 ) {
				
				// when user initates interaction, remove instructions and respond to 
				// subsequent user interaction

				//console.log("user initiated interaction - removed instructions from scene");

				scene.remove( instructionsSprite );
				displayingInstructions = false;
			}
		} else if ( deltaFov != 0 ) {

			// modfy current vertical FOV (zoom)
			fieldOfView.current = Math.max( fieldOfView.min, Math.min( fieldOfView.current + deltaFov, fieldOfView.max ) );
			camera.projectionMatrix.makePerspective( fieldOfView.current, renderCanvas.width / renderCanvas.height, 1, 1100 );
			
			// reset tilt limits for new field of view
			updateTiltLimits();
			var viewTiltOld = viewTilt.current;
			// console.log("old tilt: " + viewTiltOld);

			// re-calculate current tilt to ensure it lies within updated tilt limits
			viewTilt.current = Math.max( viewTilt.downLimit, Math.min( viewTilt.upLimit, viewTiltOld ) );
			// console.log("new tilt: " + viewTilt.current );

			if ( viewTiltOld != viewTilt.current ) {

				// if current tilt has changed then update view
				
				// console.log ( "updating tilt" );
				var phi = THREE.Math.degToRad( 90 - viewTilt.current ); // phi relative to yz plane
				camera.target.y = sphereRadius * Math.cos( phi );
				camera.lookAt( camera.target );
			}
			// reset value obtained from mouse wheel
			deltaFov = 0;

		} else if (	isUserInteracting ) {

			// rotate at most deltaLat further around X axis, without
			// exceeding tilt limits
			viewTilt.current = Math.max( viewTilt.downLimit, Math.min( viewTilt.upLimit, viewTilt.current + deltaLat ) );
			// rotate deltaLon further around Y axis
			viewPan.current = ( viewPan.current + deltaLon ) % 360.0;

			//console.log( "viewTilt.current: " + viewTilt.current );
			//console.log( "viewPan.current: " + viewPan.current );

			var phi = THREE.Math.degToRad( 90 - viewTilt.current ); // phi relative to yz plane
			var theta = THREE.Math.degToRad( viewPan.current ); // theta relative to xy plane

			camera.target.x = sphereRadius * Math.sin( phi ) * Math.cos( theta );
			camera.target.y = sphereRadius * Math.cos( phi );
			camera.target.z = sphereRadius * Math.sin( phi ) * Math.sin( theta );
			camera.lookAt( camera.target );
		}
	}

	function animate() {
		
		if ( ! stopAnimation ) {
			requestAnimationFrame( animate );
			
			if ( warpedVideo.readyState === warpedVideo.HAVE_ENOUGH_DATA ) {
				sphereTexture.needsUpdate = true;
			}
			updateView();
			renderer.render( scene, camera );
		}
	}

	this.start = function() {
		stopAnimation = false;
		animate();
	}
	
	this.stop = function() {
		stopAnimation = true;
	}
}
