// libflac.js - port of libflac to JavaScript using emscripten
(function (root, factory) {

	if (typeof define === 'function' && define.amd) {
		// AMD. Register as an anonymous module.
		define(['module', 'require'], factory.bind(null, root));
	} else if (typeof module === 'object' && module.exports) {
		// Node. Does not work with strict CommonJS, but
		// only CommonJS-like environments that support module.exports,
		// like Node.

		// use process.env (if available) for reading Flac environment settings:
		var env = typeof process !== 'undefined' && process && process.env? process.env : root;
		factory(env, module, module.require);
	} else {
		// Browser globals
		root.Flac = factory(root);
	}

}(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function (global, expLib, require) {
'use strict';

var Module = Module || {}

/**
 * Decoding error codes.
 *
 * <br>
 * If the error code is not known, value <code>FLAC__STREAM_DECODER_ERROR__UNKNOWN__</code> is used.
 *
 * @property {"FLAC__STREAM_DECODER_ERROR_STATUS_LOST_SYNC"}			0   An error in the stream caused the decoder to lose synchronization.
 * @property {"FLAC__STREAM_DECODER_ERROR_STATUS_BAD_HEADER"}  			1   The decoder encountered a corrupted frame header.
 * @property {"FLAC__STREAM_DECODER_ERROR_STATUS_FRAME_CRC_MISMATCH"}	2   The frame's data did not match the CRC in the footer.
 * @property {"FLAC__STREAM_DECODER_ERROR_STATUS_UNPARSEABLE_STREAM"}	3   The decoder encountered reserved fields in use in the stream.
 *
 *
 * @interface FLAC__StreamDecoderErrorStatus
 * @memberOf Flac
 */
var DecoderErrorCode = {
	0: 'FLAC__STREAM_DECODER_ERROR_STATUS_LOST_SYNC',
	1: 'FLAC__STREAM_DECODER_ERROR_STATUS_BAD_HEADER',
	2: 'FLAC__STREAM_DECODER_ERROR_STATUS_FRAME_CRC_MISMATCH',
	3: 'FLAC__STREAM_DECODER_ERROR_STATUS_UNPARSEABLE_STREAM'
}

var enc_write_fn_ptr;
var dec_read_fn_ptr;
var dec_write_fn_ptr;
var dec_error_fn_ptr;
var metadata_fn_ptr;

var _flac_ready = false;

//in case resources are loaded asynchronously (e.g. *.mem file for minified version): setup "ready" handling
Module["onRuntimeInitialized"] = function(){
	//(const FLAC__StreamEncoder *encoder, const FLAC__byte buffer[], size_t bytes, unsigned samples, unsigned current_frame, void *client_data)
	// -> FLAC__StreamEncoderWriteStatus
	enc_write_fn_ptr = addFunction(function(p_encoder, buffer, bytes, samples, current_frame, p_client_data){
		var retdata = new Uint8Array(bytes);
		retdata.set(HEAPU8.subarray(buffer, buffer + bytes));
		var write_callback_fn = getCallback(p_encoder, 'write');
		try{
			write_callback_fn(retdata, bytes, samples, current_frame, p_client_data);
		} catch(err) {
			console.error(err);
			return FLAC__STREAM_ENCODER_WRITE_STATUS_FATAL_ERROR;
		}
		return FLAC__STREAM_ENCODER_WRITE_STATUS_OK;
	}, 'iiiiiii');

	//(const FLAC__StreamDecoder *decoder, FLAC__byte buffer[], size_t *bytes, void *client_data)
	// -> FLAC__StreamDecoderReadStatus
	dec_read_fn_ptr = addFunction(function(p_decoder, buffer, bytes, p_client_data){
		//FLAC__StreamDecoderReadCallback, see https://xiph.org/flac/api/group__flac__stream__decoder.html#ga7a5f593b9bc2d163884348b48c4285fd

		var len = Module.getValue(bytes, 'i32');

		if(len === 0){
			return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
		}

		var read_callback_fn = getCallback(p_decoder, 'read');

		//callback must return object with: {buffer: TypedArray, readDataLength: number, error: boolean}
		var readResult = read_callback_fn(len, p_client_data);
		//in case of END_OF_STREAM or an error, readResult.readDataLength must be returned with 0

		var readLen = readResult.readDataLength;
		Module.setValue(bytes, readLen, 'i32');

		if(readResult.error){
			return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
		}

		if(readLen === 0){
			return FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM;
		}

		var readBuf = readResult.buffer;

		var dataHeap = new Uint8Array(Module.HEAPU8.buffer, buffer, readLen);
		dataHeap.set(new Uint8Array(readBuf));

		return FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
	}, 'iiiii');

	//(const FLAC__StreamDecoder *decoder, const FLAC__Frame *frame, const FLAC__int32 *const buffer[], void *client_data)
	// -> FLAC__StreamDecoderWriteStatus
	dec_write_fn_ptr = addFunction(function(p_decoder, p_frame, p_buffer, p_client_data){

		// var dec = Module.getValue(p_decoder,'i32');
		// var clientData = Module.getValue(p_client_data,'i32');

		var dec_opts = _getOptions(p_decoder);
		var frameInfo = _readFrameHdr(p_frame, dec_opts);

	//	console.log(frameInfo);//DEBUG

		var channels = frameInfo.channels;
		var block_size = frameInfo.blocksize * (frameInfo.bitsPerSample / 8);

		//whether or not to apply data fixing heuristics (e.g. not needed for 24-bit samples)
		var isFix = frameInfo.bitsPerSample !== 24;

		//take padding bits into account for calculating buffer size
		// -> seems to be done for uneven byte sizes, i.e. 1 (8 bits) and 3 (24 bits)
		var padding = (frameInfo.bitsPerSample / 8)%2;
		if(padding > 0){
			block_size += frameInfo.blocksize * padding;
		}

		var data = [];//<- array for the data of each channel
		var bufferOffset, _buffer;

		for(var i=0; i < channels; ++i){

			bufferOffset = Module.getValue(p_buffer + (i*4),'i32');

			_buffer = new Uint8Array(block_size);
			//FIXME HACK for "strange" data (see helper function __fix_write_buffer)
			__fix_write_buffer(bufferOffset, _buffer, isFix);

			data.push(_buffer.subarray(0, block_size));
		}

		var write_callback_fn = getCallback(p_decoder, 'write');
		var res = write_callback_fn(data, frameInfo);//, clientData);

		// FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE	The write was OK and decoding can continue.
		// FLAC__STREAM_DECODER_WRITE_STATUS_ABORT     	An unrecoverable error occurred. The decoder will return from the process call.

		return res !== false? FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE : FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
	}, 'iiiii');


	//(const FLAC__StreamDecoder *decoder, FLAC__StreamDecoderErrorStatus status, void *client_data)
	// -> void
	dec_error_fn_ptr = addFunction(function(p_decoder, err, p_client_data){

		//err:
		var msg = DecoderErrorCode[err] || 'FLAC__STREAM_DECODER_ERROR__UNKNOWN__';//<- this should never happen;

		var error_callback_fn = getCallback(p_decoder, 'error');
		error_callback_fn(err, msg, p_client_data);
	}, 'viii');

	//(const FLAC__StreamDecoder *decoder, const FLAC__StreamMetadata *metadata, void *client_data) -> void
	//(const FLAC__StreamEncoder *encoder, const FLAC__StreamMetadata *metadata, void *client_data) -> void
	metadata_fn_ptr = addFunction(function(p_coder, p_metadata, p_client_data){
		/*
		 typedef struct {
			FLAC__MetadataType type;
			FLAC__bool is_last;
			unsigned length;
			union {
				FLAC__StreamMetadata_StreamInfo stream_info;
				FLAC__StreamMetadata_Padding padding;
				FLAC__StreamMetadata_Application application;
				FLAC__StreamMetadata_SeekTable seek_table;
				FLAC__StreamMetadata_VorbisComment vorbis_comment;
				FLAC__StreamMetadata_CueSheet cue_sheet;
				FLAC__StreamMetadata_Picture picture;
				FLAC__StreamMetadata_Unknown unknown;
			} data;
		} FLAC__StreamMetadata;
		 */

		/*
		FLAC__METADATA_TYPE_STREAMINFO 		STREAMINFO block
		FLAC__METADATA_TYPE_PADDING 		PADDING block
		FLAC__METADATA_TYPE_APPLICATION 	APPLICATION block
		FLAC__METADATA_TYPE_SEEKTABLE 		SEEKTABLE block
		FLAC__METADATA_TYPE_VORBIS_COMMENT 	VORBISCOMMENT block (a.k.a. FLAC tags)
		FLAC__METADATA_TYPE_CUESHEET 		CUESHEET block
		FLAC__METADATA_TYPE_PICTURE 		PICTURE block
		FLAC__METADATA_TYPE_UNDEFINED 		marker to denote beginning of undefined type range; this number will increase as new metadata types are added
		FLAC__MAX_METADATA_TYPE 			No type will ever be greater than this. There is not enough room in the protocol block.
		 */

		var type = Module.getValue(p_metadata,'i32');//4 bytes
		var is_last = Module.getValue(p_metadata+4,'i32');//4 bytes
		var length = Module.getValue(p_metadata+8,'i64');//8 bytes

		var meta_data = {
			type: type,
			isLast: is_last,
			length: length,
			data: void(0)
		};

		var metadata_callback_fn = getCallback(p_coder, 'metadata');
		if(type === 0){// === FLAC__METADATA_TYPE_STREAMINFO

			meta_data.data = _readStreamInfo(p_metadata+16);
			metadata_callback_fn(meta_data.data, meta_data);

		} else {

			var data;
			switch(type){
				case 1: //FLAC__METADATA_TYPE_PADDING
					data = _readPaddingMetadata(p_metadata+16);
					break;
				case 2: //FLAC__METADATA_TYPE_APPLICATION
					data =  readApplicationMetadata(p_metadata+16);
					break;
				case 3: //FLAC__METADATA_TYPE_SEEKTABLE
					data = _readSeekTableMetadata(p_metadata+16);
					break;

				case 4: //FLAC__METADATA_TYPE_VORBIS_COMMENT
					data = _readVorbisComment(p_metadata+16);
					break;

				case 5: //FLAC__METADATA_TYPE_CUESHEET
					data = _readCueSheetMetadata(p_metadata+16);
					break;

				case 6: //FLAC__METADATA_TYPE_PICTURE
					data = _readPictureMetadata(p_metadata+16);
					break;
				default: { //NOTE this should not happen, and the raw data is very likely not correct!
					var cod_opts = _getOptions(p_coder);
					if(cod_opts && cod_opts.enableRawMetadata){
						var buffer = Uint8Array.from(HEAPU8.subarray(p_metadata+16, p_metadata+16+length));
						meta_data.raw = buffer;
					}
				}

			}

			meta_data.data = data;
			metadata_callback_fn(void(0), meta_data);
		}

	}, 'viii');
	_flac_ready = true;
	if(!_exported){
		//if _exported is not yet set (may happen, in case initialization was strictly synchronously),
		// do "pause" until sync initialization has run through
		setTimeout(function(){do_fire_event('ready', [{type: 'ready', target: _exported}], true);}, 0);
	} else {
		do_fire_event('ready', [{type: 'ready', target: _exported}], true);
	}
};
