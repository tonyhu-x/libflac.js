//libflac function wrappers

/**
 * HELPER read/extract stream info meta-data from frame header / meta-data
 * @param {POINTER} p_streaminfo
 * @returns StreamInfo
 */
function _readStreamInfo(p_streaminfo){//-> FLAC__StreamMetadata.type (FLAC__MetadataType) === FLAC__METADATA_TYPE_STREAMINFO (0)

	/*
	typedef struct {
		unsigned min_blocksize, max_blocksize;
		unsigned min_framesize, max_framesize;
		unsigned sample_rate;
		unsigned channels;
		unsigned bits_per_sample;
		FLAC__uint64 total_samples;
		FLAC__byte md5sum[16];
	} FLAC__StreamMetadata_StreamInfo;
	 */

	var min_blocksize = Module.getValue(p_streaminfo,'i32');//4 bytes
	var max_blocksize = Module.getValue(p_streaminfo+4,'i32');//4 bytes

	var min_framesize = Module.getValue(p_streaminfo+8,'i32');//4 bytes
	var max_framesize = Module.getValue(p_streaminfo+12,'i32');//4 bytes

	var sample_rate = Module.getValue(p_streaminfo+16,'i32');//4 bytes
	var channels = Module.getValue(p_streaminfo+20,'i32');//4 bytes

	var bits_per_sample = Module.getValue(p_streaminfo+24,'i32');//4 bytes

	//FIXME should be at p_streaminfo+28, but seems to be at p_streaminfo+32
	var total_samples = Module.getValue(p_streaminfo+32,'i64');//8 bytes

	var md5sum = _readMd5(p_streaminfo+40);//16 bytes

	return {
		min_blocksize: min_blocksize,
		max_blocksize: max_blocksize,
		min_framesize: min_framesize,
		max_framesize: max_framesize,
		sampleRate: sample_rate,
		channels: channels,
		bitsPerSample: bits_per_sample,
		total_samples: total_samples,
		md5sum: md5sum
	};
}

/**
 * read MD5 checksum
 * @param {POINTER} p_md5
 * @returns {String} as HEX string representation
 */
function _readMd5(p_md5){

	var sb = [], v, str;
	for(var i=0, len = 16; i < len; ++i){
		v = Module.getValue(p_md5+i,'i8');//1 byte
		if(v < 0) v = 256 + v;//<- "convert" to uint8, if necessary
		str = v.toString(16);
		if(str.length < 2) str = '0' + str;//<- add padding, if necessary
		sb.push(str);
	}
	return sb.join('');
}

/**
 * HELPER: read frame data
 *
 * @param {POINTER} p_frame
 * @param {Flac.CodingOptions} [enc_opt]
 * @returns FrameHeader
 */
function _readFrameHdr(p_frame, enc_opt){

	/*
	typedef struct {
		unsigned blocksize;
		unsigned sample_rate;
		unsigned channels;
		FLAC__ChannelAssignment channel_assignment;
		unsigned bits_per_sample;
		FLAC__FrameNumberType number_type;
		union {
			FLAC__uint32 frame_number;
			FLAC__uint64 sample_number;
		} number;
		FLAC__uint8 crc;
	} FLAC__FrameHeader;
	 */

	var blocksize = Module.getValue(p_frame,'i32');//4 bytes
	var sample_rate = Module.getValue(p_frame+4,'i32');//4 bytes
	var channels = Module.getValue(p_frame+8,'i32');//4 bytes

	// 0: FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT	independent channels
	// 1: FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE 	left+side stereo
	// 2: FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE 	right+side stereo
	// 3: FLAC__CHANNEL_ASSIGNMENT_MID_SIDE 	mid+side stereo
	var channel_assignment = Module.getValue(p_frame+12,'i32');//4 bytes

	var bits_per_sample = Module.getValue(p_frame+16,'i32');

	// 0: FLAC__FRAME_NUMBER_TYPE_FRAME_NUMBER 	number contains the frame number
	// 1: FLAC__FRAME_NUMBER_TYPE_SAMPLE_NUMBER	number contains the sample number of first sample in frame
	var number_type = Module.getValue(p_frame+20,'i32');

	// union {} number: The frame number or sample number of first sample in frame; use the number_type value to determine which to use.
	var frame_number = Module.getValue(p_frame+24,'i32');
	var sample_number = Module.getValue(p_frame+24,'i64');

	var number = number_type === 0? frame_number : sample_number;
	var numberType = number_type === 0? 'frames' : 'samples';

	var crc = Module.getValue(p_frame+36,'i8');

	var subframes;
	if(enc_opt && enc_opt.analyseSubframes){
		var subOffset = {offset: 40};
		subframes = [];
		for(var i=0; i < channels; ++i){
			subframes.push(_readSubFrameHdr(p_frame, subOffset, blocksize, enc_opt));
		}
		//TODO read footer
		// console.log('  footer crc ', Module.getValue(p_frame + subOffset.offset,'i16'));
	}

	return {
		blocksize: blocksize,
		sampleRate: sample_rate,
		channels: channels,
		channelAssignment: channel_assignment,
		bitsPerSample: bits_per_sample,
		number: number,
		numberType: numberType,
		crc: crc,
		subframes: subframes
	};
}


function _readSubFrameHdr(p_subframe, subOffset, block_size, enc_opt){
	/*
	FLAC__SubframeType 	type
	union {
	   FLAC__Subframe_Constant   constant
	   FLAC__Subframe_Fixed   fixed
	   FLAC__Subframe_LPC   lpc
	   FLAC__Subframe_Verbatim   verbatim
	} 	data
	unsigned 	wasted_bits
	*/

	var type = Module.getValue(p_subframe + subOffset.offset, 'i32');
	subOffset.offset += 4;

	var data;
	switch(type){
		case 0:	//FLAC__SUBFRAME_TYPE_CONSTANT
			data = {value: Module.getValue(p_subframe + subOffset.offset, 'i32')};
			subOffset.offset += 284;//4;
			break;
		case 1:	//FLAC__SUBFRAME_TYPE_VERBATIM
			data = Module.getValue(p_subframe + subOffset.offset, 'i32');
			subOffset.offset += 284;//4;
			break;
		case 2:	//FLAC__SUBFRAME_TYPE_FIXED
			data = _readSubFrameHdrFixedData(p_subframe, subOffset, block_size, false, enc_opt);
			break;
		case 3:	//FLAC__SUBFRAME_TYPE_LPC
			data = _readSubFrameHdrFixedData(p_subframe, subOffset, block_size, true, enc_opt);
			break;
	}

	var offset =  subOffset.offset;
	var wasted_bits = Module.getValue(p_subframe + offset, 'i32');
	subOffset.offset += 4;

	return {
		type: type,//['CONSTANT', 'VERBATIM', 'FIXED', 'LPC'][type],
		data: data,
		wastedBits: wasted_bits
	}
}

function _readSubFrameHdrFixedData(p_subframe_data, subOffset, block_size, is_lpc, enc_opt){

	var offset = subOffset.offset;

	var data = {order: -1, contents: {parameters: [], rawBits: []}};
	//FLAC__Subframe_Fixed:
	// FLAC__EntropyCodingMethod 	entropy_coding_method
	// unsigned 	order
	// FLAC__int32 	warmup [FLAC__MAX_FIXED_ORDER]
	// const FLAC__int32 * 	residual

	//FLAC__EntropyCodingMethod:
	// FLAC__EntropyCodingMethodType 	type
	// union {
	//    FLAC__EntropyCodingMethod_PartitionedRice   partitioned_rice
	// } 	data

	//FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE	0		Residual is coded by partitioning into contexts, each with it's own 4-bit Rice parameter.
	//FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2 1	Residual is coded by partitioning into contexts, each with it's own 5-bit Rice parameter.
	var entropyType = Module.getValue(p_subframe_data, 'i32');
	offset += 4;

	//FLAC__EntropyCodingMethod_PartitionedRice:
	//	unsigned 	order
	var entropyOrder = Module.getValue(p_subframe_data + offset, 'i32');
	data.order = entropyOrder;
	offset += 4;

	//FLAC__EntropyCodingMethod_PartitionedRice:
	//	FLAC__EntropyCodingMethod_PartitionedRiceContents * 	contents
	var partitions = 1 << entropyOrder, params = data.contents.parameters, raws = data.contents.rawBits;
	//FLAC__EntropyCodingMethod_PartitionedRiceContents
	// unsigned * 	parameters
	// unsigned * 	raw_bits
	// unsigned 	capacity_by_order
	var ppart = Module.getValue(p_subframe_data + offset, 'i32');
	var pparams = Module.getValue(ppart, 'i32');
	var praw = Module.getValue(ppart + 4, 'i32');
	data.contents.capacityByOrder = Module.getValue(ppart + 8, 'i32');
	for(var i=0; i < partitions; ++i){
		params.push(Module.getValue(pparams + (i*4), 'i32'));
		raws.push(Module.getValue(praw + (i*4), 'i32'));
	}
	offset += 4;

	//FLAC__Subframe_Fixed:
	//	unsigned 	order
	var order = Module.getValue(p_subframe_data + offset, 'i32');
	offset += 4;

	var warmup = [], res;

	if(is_lpc){
		//FLAC__Subframe_LPC

		// unsigned 	qlp_coeff_precision
		var qlp_coeff_precision = Module.getValue(p_subframe_data + offset, 'i32');
		offset += 4;
		// int 	quantization_level
		var quantization_level = Module.getValue(p_subframe_data + offset, 'i32');
		offset += 4;

		//FLAC__Subframe_LPC :
		// FLAC__int32 	qlp_coeff [FLAC__MAX_LPC_ORDER]
		var qlp_coeff = [];
		for(var i=0; i < order; ++i){
			qlp_coeff.push(Module.getValue(p_subframe_data + offset, 'i32'));
			offset += 4;
		}
		data.qlp_coeff = qlp_coeff;
		data.qlp_coeff_precision = qlp_coeff_precision;
		data.quantization_level = quantization_level;

		//FLAC__Subframe_LPC:
		// FLAC__int32 	warmup [FLAC__MAX_LPC_ORDER]
		offset = subOffset.offset + 152;
		offset = _readSubFrameHdrWarmup(p_subframe_data, offset, warmup, order);

		//FLAC__Subframe_LPC:
		// const FLAC__int32 * 	residual
		if(enc_opt && enc_opt.analyseResiduals){
			offset = subOffset.offset + 280;
			res = _readSubFrameHdrResidual(p_subframe_data + offset, block_size, order);
		}

	} else {

		//FLAC__Subframe_Fixed:
		// FLAC__int32 	warmup [FLAC__MAX_FIXED_ORDER]
		offset = _readSubFrameHdrWarmup(p_subframe_data, offset, warmup, order);

		//FLAC__Subframe_Fixed:
		// const FLAC__int32 * 	residual
		offset = subOffset.offset + 32;
		if(enc_opt && enc_opt.analyseResiduals){
			res = _readSubFrameHdrResidual(p_subframe_data + offset, block_size, order);
		}
	}

	subOffset.offset += 284;
	return {
		partition: {
			type: entropyType,
			data: data
		},
		order: order,
		warmup: warmup,
		residual: res
	}
}


function _readSubFrameHdrWarmup(p_subframe_data, offset, warmup, order){

	// FLAC__int32 	warmup [FLAC__MAX_FIXED_ORDER | FLAC__MAX_LPC_ORDER]
	for(var i=0; i < order; ++i){
		warmup.push(Module.getValue(p_subframe_data + offset, 'i32'));
		offset += 4;
	}
	return offset;
}


function _readSubFrameHdrResidual(p_subframe_data_res, block_size, order){
	// const FLAC__int32 * 	residual
	var pres = Module.getValue(p_subframe_data_res, 'i32');
	var res = [];//Module.getValue(pres, 'i32');
	//TODO read residual all values(?)
	// -> "The residual signal, length == (blocksize minus order) samples.
	for(var i=0, size = block_size - order; i < size; ++i){
		res.push(Module.getValue(pres + (i*4), 'i32'));
	}
	return res;
}

function _readConstChar(ptr, length, sb){
	sb.splice(0);
	var ch;
	for(var i=0; i < length; ++i){
		ch = Module.getValue(ptr + i,'i8');
		if(ch === 0){
			break;
		}
		sb.push(String.fromCodePoint(ch));
	}
	return sb.join('');
}

function _readNullTerminatedChar(ptr, sb){
	sb.splice(0);
	var ch = 1, i = 0;
	while(ch > 0){
		ch = Module.getValue(ptr + i++, 'i8');
		if(ch === 0){
			break;
		}
		sb.push(String.fromCodePoint(ch));
	}
	return sb.join('');
}


/**
 * HELPER read/extract padding metadata meta-data from meta-data block
 * @param {POINTER} p_padding_metadata
 * @returns PaddingMetadata
 */
function _readPaddingMetadata(p_padding_metadata){//-> FLAC__StreamMetadata.type (FLAC__MetadataType) === FLAC__METADATA_TYPE_PADDING (1)

	//FLAC__StreamMetadata_Padding:
	//		int 	dummy
	return {
		dummy: Module.getValue(p_padding_metadata,'i32')
	}
}

/**
 * HELPER read/extract application metadata meta-data from meta-data block
 * @param {POINTER} p_application_metadata
 * @returns ApplicationMetadata
 */
function _readApplicationMetadata(p_application_metadata){//-> FLAC__StreamMetadata.type (FLAC__MetadataType) === FLAC__METADATA_TYPE_APPLICATION (2)

	//FLAC__StreamMetadata_Application:
	// FLAC__byte 	id [4]
	// FLAC__byte * 	data
	return {
		id : Module.getValue(p_application_metadata,'i32'),
		data: Module.getValue(p_application_metadata + 4,'i32')//TODO should read (binary) data?
	}
}


/**
 * HELPER read/extract seek table metadata meta-data from meta-data block
 * @param {POINTER} p_seek_table_metadata
 * @returns SeekTableMetadata
 */
function _readSeekTableMetadata(p_seek_table_metadata){//-> FLAC__StreamMetadata.type (FLAC__MetadataType) === FLAC__METADATA_TYPE_SEEKTABLE (3)

	//FLAC__StreamMetadata_SeekTable:
	// 	unsigned 	num_points
	// 	FLAC__StreamMetadata_SeekPoint * 	points

	var num_points = Module.getValue(p_seek_table_metadata,'i32');

	var ptrPoints = Module.getValue(p_seek_table_metadata + 4,'i32');
	var points = [];
	for(var i=0; i < num_points; ++i){

		//FLAC__StreamMetadata_SeekPoint:
		// 	FLAC__uint64 	sample_number
		// 	FLAC__uint64 	stream_offset
		// 	unsigned 	frame_samples

		points.push({
			sample_number: Module.getValue(ptrPoints + (i * 24),'i64'),
			stream_offset: Module.getValue(ptrPoints + (i * 24) + 8,'i64'),
			frame_samples: Module.getValue(ptrPoints + (i * 24) + 16,'i32')
		});
	}

	return {
		num_points: num_points,
		points: points
	}
}

/**
 * HELPER read/extract vorbis comment meta-data from meta-data block
 * @param {POINTER} p_vorbiscomment
 * @returns VorbisComment
 */
function _readVorbisComment(p_vorbiscomment){//-> FLAC__StreamMetadata.type (FLAC__MetadataType) === FLAC__METADATA_TYPE_VORBIS_COMMENT (4)

	// FLAC__StreamMetadata_VorbisComment
	// FLAC__StreamMetadata_VorbisComment_Entry vendor_string:
	// 		FLAC__uint32 	length
	// 		FLAC__byte * 	entry
	var length = Module.getValue(p_vorbiscomment,'i32');
	var entry = Module.getValue(p_vorbiscomment + 4,'i32');

	var sb = [];
	var strEntry = _readConstChar(entry, length, sb);

	// FLAC__uint32 	num_comments
	var num_comments = Module.getValue(p_vorbiscomment + 8,'i32');

	// FLAC__StreamMetadata_VorbisComment_Entry * 	comments
	var comments = [], clen, centry;
	var pc = Module.getValue(p_vorbiscomment + 12, 'i32')
	for(var i=0; i < num_comments; ++i){

		// FLAC__StreamMetadata_VorbisComment_Entry
		// 		FLAC__uint32 	length
		// 		FLAC__byte * 	entry

		clen = Module.getValue(pc + (i*8), 'i32');
		if(clen === 0){
			continue;
		}

		centry = Module.getValue(pc + (i*8) + 4, 'i32');
		comments.push(_readConstChar(centry, clen, sb));
	}

	return {
		vendor_string: strEntry,
		num_comments: num_comments,
		comments: comments
	}
}

/**
 * HELPER read/extract cue sheet meta-data from meta-data block
 * @param {POINTER} p_cue_sheet
 * @returns CueSheetMetadata
 */
function _readCueSheetMetadata(p_cue_sheet){//-> FLAC__StreamMetadata.type (FLAC__MetadataType) === FLAC__METADATA_TYPE_CUESHEET (5)

	// char 	media_catalog_number [129]
	// FLAC__uint64 	lead_in
	// FLAC__bool 	is_cd
	// unsigned 	num_tracks
	// FLAC__StreamMetadata_CueSheet_Track * 	tracks

	var sb = [];
	var media_catalog_number = _readConstChar(p_cue_sheet, 129, sb);

	var lead_in = Module.getValue(p_cue_sheet + 136,'i64');

	var is_cd = Module.getValue(p_cue_sheet + 144,'i8');
	var num_tracks = Module.getValue(p_cue_sheet + 148,'i32');

	var ptrTrack = Module.getValue(p_cue_sheet + 152,'i32');
	var tracks = [], trackOffset = ptrTrack;
	if(ptrTrack !== 0){

		for(var i=0; i < num_tracks; ++i){

			var tr = _readCueSheetMetadata_track(trackOffset, sb);
			tracks.push(tr);
			trackOffset += 32;
		}
	}

	return {
		media_catalog_number: media_catalog_number,
		lead_in: lead_in,
		is_cd: is_cd,
		num_tracks: num_tracks,
		tracks: tracks
	}
}

/**
 * helper read track data for cue-sheet metadata
 * @param       {POINTER} p_cue_sheet_track pointer to the track data
 * @param       {string[]} sb "string buffer" temporary buffer for reading string (may be reset)
 * @return      {CueSheetTrack}
 */
function _readCueSheetMetadata_track(p_cue_sheet_track, sb){

	// FLAC__StreamMetadata_CueSheet_Track:
	// 		FLAC__uint64 	offset
	// 		FLAC__byte 	number
	// 		char 	isrc [13]
	//		 unsigned 	type:1
	// 		unsigned 	pre_emphasis:1
	// 		FLAC__byte 	num_indices
	// 		FLAC__StreamMetadata_CueSheet_Index * 	indices

	var typePremph = Module.getValue(p_cue_sheet_track + 22,'i8');
	var num_indices = Module.getValue(p_cue_sheet_track + 23,'i8');

	var indices = [];
	var track = {
		offset: Module.getValue(p_cue_sheet_track,'i64'),
		number: Module.getValue(p_cue_sheet_track + 8,'i8') &255,
		isrc: _readConstChar(p_cue_sheet_track + 9, 13, sb),
		type: typePremph & 1? 'NON_AUDIO' : 'AUDIO',
		pre_emphasis: !!(typePremph & 2),
		num_indices: num_indices,
		indices: indices
	}

	var idx;
	if(num_indices > 0){
		idx = Module.getValue(p_cue_sheet_track + 24,'i32');

		//FLAC__StreamMetadata_CueSheet_Index:
		// 	FLAC__uint64 	offset
		// 	FLAC__byte 	number

		for(var i=0; i < num_indices; ++i){
			indices.push({
				offset: Module.getValue(idx + (i*16),'i64'),
				number: Module.getValue(idx + (i*16) + 8,'i8')
			});
		}
	}

	return track;
}

/**
 * HELPER read/extract picture meta-data from meta-data block
 * @param {POINTER} p_picture_metadata
 * @returns PictureMetadata
 */
function _readPictureMetadata(p_picture_metadata){//-> FLAC__StreamMetadata.type (FLAC__MetadataType) === FLAC__METADATA_TYPE_PICTURE (6)

	// FLAC__StreamMetadata_Picture_Type 	type
	// char * 	mime_type
	// FLAC__byte * 	description
	// FLAC__uint32 	width
	// FLAC__uint32 	height
	// FLAC__uint32 	depth
	// FLAC__uint32 	colors
	// FLAC__uint32 	data_length
	// FLAC__byte * 	data

	var type = Module.getValue(p_picture_metadata,'i32');

	var mime = Module.getValue(p_picture_metadata + 4,'i32');

	var sb = [];
	var mime_type = _readNullTerminatedChar(mime, sb);

	var desc = Module.getValue(p_picture_metadata + 8,'i32');
	var description = _readNullTerminatedChar(desc, sb);

	var width  = Module.getValue(p_picture_metadata + 12,'i32');
	var height = Module.getValue(p_picture_metadata + 16,'i32');
	var depth  = Module.getValue(p_picture_metadata + 20,'i32');
	var colors = Module.getValue(p_picture_metadata + 24,'i32');
	var data_length = Module.getValue(p_picture_metadata + 28,'i32');

	var data = Module.getValue(p_picture_metadata + 32,'i32');

	var buffer = Uint8Array.from(Module.HEAPU8.subarray(data, data + data_length));

	return {
		type: type,
		mime_type: mime_type,
		description: description,
		width: width,
		height: height,
		depth: depth,
		colors: colors,
		data_length: data_length,
		data: buffer
	}
}

/**
 * HELPER workaround / fix for returned write-buffer when decoding FLAC
 *
 * @param {number} heapOffset
 * 				the offset for the data on HEAPU8
 * @param {Uint8Array} newBuffer
 * 				the target buffer into which the data should be written -- with the correct (block) size
 * @param {boolean} applyFix
 * 				whether or not to apply the data repair heuristics
 * 				(handling duplicated/triplicated values in raw data)
 */
function __fix_write_buffer(heapOffset, newBuffer, applyFix){

	var dv = new DataView(newBuffer.buffer);
	var targetSize = newBuffer.length;

	var increase = !applyFix? 1 : 2;//<- for FIX/workaround, NOTE: e.g. if 24-bit padding occurres, there is no fix/increase needed (more details comment below)
	var buffer = HEAPU8.subarray(heapOffset, heapOffset + targetSize * increase);

	// FIXME for some reason, the bytes values 0 (min) and 255 (max) get "triplicated",
	//		or inserted "doubled" which should be ignored, i.e.
	//		x x x	-> x
	//		x x		-> <ignored>
	//		where x is 0 or 255
	// -> HACK for now: remove/"over-read" 2 of the values, for each of these triplets/doublications
	var jump, isPrint;
	for(var i=0, j=0, size = buffer.length; i < size && j < targetSize; ++i, ++j){

		if(i === size-1 && j < targetSize - 1){
			//increase heap-view, in order to read more (valid) data into the target buffer
			buffer = HEAPU8.subarray(heapOffset, size + targetSize);
			size = buffer.length;
		}

		// NOTE if e.g. 24-bit padding occurres, there does not seem to be no duplication/triplication of 255 or 0, so must not try to fix!
		if(applyFix && (buffer[i] === 0 || buffer[i] === 255)){

			jump = 0;
			isPrint = true;

			if(i + 1 < size && buffer[i] === buffer[i+1]){

				++jump;

				if(i + 2 < size){
					if(buffer[i] === buffer[i+2]){
						++jump;
					} else {
						//if only 2 occurrences: ignore value
						isPrint = false;
					}
				}
			}//else: if single value: do print (an do not jump)


			if(isPrint){
				dv.setUint8(j, buffer[i]);
				if(jump === 2 && i + 3 < size && buffer[i] === buffer[i+3]){
					//special case for reducing triples in case the following value is also the same
					// (ie. something like: x x x |+ x)
					// -> then: do write the value one more time, and jump one further ahead
					// i.e. if value occurs 4 times in a row, write 2 values
					++jump;
					dv.setUint8(++j, buffer[i]);
				}
			} else {
				--j;
			}

			i += jump;//<- apply jump, if there were value duplications

		} else {
			dv.setUint8(j, buffer[i]);
		}

	}
}


// FLAC__STREAM_DECODER_READ_STATUS_CONTINUE     	The read was OK and decoding can continue.
// FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM   The read was attempted while at the end of the stream. Note that the client must only return this value when the read callback was called when already at the end of the stream. Otherwise, if the read itself moves to the end of the stream, the client should still return the data and FLAC__STREAM_DECODER_READ_STATUS_CONTINUE, and then on the next read callback it should return FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM with a byte count of 0.
// FLAC__STREAM_DECODER_READ_STATUS_ABORT       	An unrecoverable error occurred. The decoder will return from the process call.
var FLAC__STREAM_DECODER_READ_STATUS_CONTINUE = 0;
var FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM = 1;
var FLAC__STREAM_DECODER_READ_STATUS_ABORT = 2;

// FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE   The write was OK and decoding can continue.
// FLAC__STREAM_DECODER_WRITE_STATUS_ABORT     	An unrecoverable error occurred. The decoder will return from the process call.
var FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE = 0;
var FLAC__STREAM_DECODER_WRITE_STATUS_ABORT = 1;

/**
 * @interface FLAC__StreamDecoderInitStatus
 * @memberOf Flac
 *
 * @property {"FLAC__STREAM_DECODER_INIT_STATUS_OK"}						0 	Initialization was successful.
 * @property {"FLAC__STREAM_DECODER_INIT_STATUS_UNSUPPORTED_CONTAINER"}		1 	The library was not compiled with support for the given container format.
 * @property {"FLAC__STREAM_DECODER_INIT_STATUS_INVALID_CALLBACKS"}			2 	A required callback was not supplied.
 * @property {"FLAC__STREAM_DECODER_INIT_STATUS_MEMORY_ALLOCATION_ERROR"}	3 	An error occurred allocating memory.
 * @property {"FLAC__STREAM_DECODER_INIT_STATUS_ERROR_OPENING_FILE"}		4 	fopen() failed in FLAC__stream_decoder_init_file() or FLAC__stream_decoder_init_ogg_file().
 * @property {"FLAC__STREAM_DECODER_INIT_STATUS_ALREADY_INITIALIZED"}		5 	FLAC__stream_decoder_init_*() was called when the decoder was already initialized, usually because FLAC__stream_decoder_finish() was not called.
 */
var FLAC__STREAM_DECODER_INIT_STATUS_OK	= 0;
var FLAC__STREAM_DECODER_INIT_STATUS_UNSUPPORTED_CONTAINER	= 1;
var FLAC__STREAM_DECODER_INIT_STATUS_INVALID_CALLBACKS	= 2;
var FLAC__STREAM_DECODER_INIT_STATUS_MEMORY_ALLOCATION_ERROR = 3;
var FLAC__STREAM_DECODER_INIT_STATUS_ERROR_OPENING_FILE = 4;
var FLAC__STREAM_DECODER_INIT_STATUS_ALREADY_INITIALIZED = 5;

/**
 * @interface FLAC__StreamEncoderInitStatus
 * @memberOf Flac
 *
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_OK"}									0 	Initialization was successful.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_ENCODER_ERROR"}							1 	General failure to set up encoder; call FLAC__stream_encoder_get_state() for cause.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_UNSUPPORTED_CONTAINER"}					2 	The library was not compiled with support for the given container format.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_CALLBACKS"}						3 	A required callback was not supplied.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_NUMBER_OF_CHANNELS"}			4 	The encoder has an invalid setting for number of channels.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_BITS_PER_SAMPLE"}				5 	The encoder has an invalid setting for bits-per-sample. FLAC supports 4-32 bps but the reference encoder currently supports only up to 24 bps.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_SAMPLE_RATE"}					6 	The encoder has an invalid setting for the input sample rate.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_BLOCK_SIZE"}					7 	The encoder has an invalid setting for the block size.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_MAX_LPC_ORDER"}					8 	The encoder has an invalid setting for the maximum LPC order.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_QLP_COEFF_PRECISION"}			9 	The encoder has an invalid setting for the precision of the quantized linear predictor coefficients.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_BLOCK_SIZE_TOO_SMALL_FOR_LPC_ORDER"}	10 	The specified block size is less than the maximum LPC order.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_NOT_STREAMABLE"}						11 	The encoder is bound to the Subset but other settings violate it.
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_METADATA"}						12 	The metadata input to the encoder is invalid, in one of the following ways:
 *																						      FLAC__stream_encoder_set_metadata() was called with a null pointer but a block count > 0
 *																						      One of the metadata blocks contains an undefined type
 *																						      It contains an illegal CUESHEET as checked by FLAC__format_cuesheet_is_legal()
 *																						      It contains an illegal SEEKTABLE as checked by FLAC__format_seektable_is_legal()
 *																						      It contains more than one SEEKTABLE block or more than one VORBIS_COMMENT block
 * @property {"FLAC__STREAM_ENCODER_INIT_STATUS_ALREADY_INITIALIZED"}					13 	FLAC__stream_encoder_init_*() was called when the encoder was already initialized, usually because FLAC__stream_encoder_finish() was not called.
 */
var FLAC__STREAM_ENCODER_INIT_STATUS_OK = 0;
var FLAC__STREAM_ENCODER_INIT_STATUS_ENCODER_ERROR = 1;
var FLAC__STREAM_ENCODER_INIT_STATUS_UNSUPPORTED_CONTAINER = 2;
var FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_CALLBACKS = 3;
var FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_NUMBER_OF_CHANNELS = 4;
var FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_BITS_PER_SAMPLE = 5;
var FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_SAMPLE_RATE = 6;
var FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_BLOCK_SIZE = 7;
var FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_MAX_LPC_ORDER = 8;
var FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_QLP_COEFF_PRECISION = 9;
var FLAC__STREAM_ENCODER_INIT_STATUS_BLOCK_SIZE_TOO_SMALL_FOR_LPC_ORDER = 10;
var FLAC__STREAM_ENCODER_INIT_STATUS_NOT_STREAMABLE = 11;
var FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_METADATA = 12;
var FLAC__STREAM_ENCODER_INIT_STATUS_ALREADY_INITIALIZED = 13;

//FLAC__STREAM_ENCODER_WRITE_STATUS_OK 				The write was OK and encoding can continue.
//FLAC__STREAM_ENCODER_WRITE_STATUS_FATAL_ERROR		An unrecoverable error occurred. The encoder will return from the process call
var FLAC__STREAM_ENCODER_WRITE_STATUS_OK = 0;
var FLAC__STREAM_ENCODER_WRITE_STATUS_FATAL_ERROR = 1;


/**
 * Map for encoder/decoder callback functions
 *
 * <pre>[ID] -> {function_type: FUNCTION}</pre>
 *
 * type: {[id: number]: {[callback_type: string]: function}}
 * @private
 */
var coders = {};

/**
 * Get a registered callback for the encoder / decoder instance
 *
 * @param {Number} p_coder
 * 			the encoder/decoder pointer (ID)
 * @param {String} func_type
 * 			the callback type, one of
 * 				"write" | "read" | "error" | "metadata"
 * @returns {Function} the callback (or VOID if there is no callback registered)
 * @private
 */
function getCallback(p_coder, func_type){
	if(coders[p_coder]){
		return coders[p_coder][func_type];
	}
}

/**
 * Register a callback for an encoder / decoder instance (will / should be deleted, when finish()/delete())
 *
 * @param {Number} p_coder
 * 			the encoder/decoder pointer (ID)
 * @param {String} func_type
 * 			the callback type, one of
 * 				"write" | "read" | "error" | "metadata"
 * @param {Function} callback
 * 			the callback function
 * @private
 */
function setCallback(p_coder, func_type, callback){
	if(!coders[p_coder]){
		coders[p_coder] = {};
	}
	coders[p_coder][func_type] = callback;
}

/**
 * Get coding options for the encoder / decoder instance:
 * returns FALSY when not set.
 *
 * @param {Number} p_coder
 * 			the encoder/decoder pointer (ID)
 * @returns {CodingOptions} the coding options
 * @private
 * @memberOf Flac
 */
function _getOptions(p_coder){
	if(coders[p_coder]){
		return coders[p_coder]["options"];
	}
}

/**
 * Set coding options for an encoder / decoder instance (will / should be deleted, when finish()/delete())
 *
 * @param {Number} p_coder
 * 			the encoder/decoder pointer (ID)
 * @param {Flac.CodingOptions} options
 * 			the coding options
 * @private
 * @memberOf Flac
 */
function _setOptions(p_coder, options){
	if(!coders[p_coder]){
		coders[p_coder] = {};
	}
	coders[p_coder]["options"] = options;
}

////////////// helper fields and functions for event handling
// see exported on()/off() functions
var listeners = {};
var persistedEvents = [];
var add_event_listener = function (eventName, listener){
	var list = listeners[eventName];
	if(!list){
		list = [listener];
		listeners[eventName] = list;
	} else {
		list.push(listener);
	}
	check_and_trigger_persisted_event(eventName, listener);
};
var check_and_trigger_persisted_event = function(eventName, listener){
	var activated;
	for(var i=persistedEvents.length-1; i >= 0; --i){
		activated = persistedEvents[i];
		if(activated && activated.event === eventName){
			listener.apply(null, activated.args);
			break;
		}
	}
};
var remove_event_listener = function (eventName, listener){
	var list = listeners[eventName];
	if(list){
		for(var i=list.length-1; i >= 0; --i){
			if(list[i] === listener){
				list.splice(i, 1);
			}
		}
	}
};
/**
 * HELPER: fire an event
 * @param  {string} eventName
 * 										the event name
 * @param  {any[]} [args] OPITIONAL
 * 										the arguments when triggering the listeners
 * @param  {boolean} [isPersist] OPTIONAL (positinal argument!)
 * 										if TRUE, handlers for this event that will be registered after this will get triggered immediately
 * 										(i.e. event is "persistent": once triggered it stays "active")
 *
 */
var do_fire_event = function (eventName, args, isPersist){
	if(_exported['on'+eventName]){
		_exported['on'+eventName].apply(null, args);
	}
	var list = listeners[eventName];
	if(list){
		for(var i=0, size=list.length; i < size; ++i){
			list[i].apply(null, args)
		}
	}
	if(isPersist){
		persistedEvents.push({event: eventName, args: args});
	}
}

/////////////////////////////////////    export / public: /////////////////////////////////////////////
/**
 * The <code>Flac</code> module that provides functionality
 * for encoding WAV/PCM audio to Flac and decoding Flac to PCM.
 *
 * <br/><br/>
 * <p>
 * NOTE most functions are named analogous to the original C library functions,
 *      so that its documentation may be used for further reading.
 * </p>
 *
 * @see https://xiph.org/flac/api/group__flac__stream__encoder.html
 * @see https://xiph.org/flac/api/group__flac__stream__decoder.html
 *
 * @class Flac
 * @namespace Flac
 */
var _exported = {
	_module: Module,//internal: reference to Flac module
	_clear_enc_cb: function(enc_ptr){//internal function: remove reference to encoder instance and its callbacks
		delete coders[enc_ptr];
	},
	_clear_dec_cb: function(dec_ptr){//internal function: remove reference to decoder instance and its callbacks
		delete coders[dec_ptr];
	},
	/**
	 * Additional options for encoding or decoding
	 * @interface CodingOptions
	 * @memberOf Flac
	 * @property {boolean}  [analyseSubframes] for decoding: include subframes metadata in write-callback metadata, DEFAULT: false
	 * @property {boolean}  [analyseResiduals] for decoding: include residual data in subframes metadata in write-callback metadata, NOTE {@link #analyseSubframes} muste also be enabled, DEFAULT: false
	 * @property {boolean}  [enableRawMetadata] DEBUG option for decoding: enable receiving raw metadata for unknown metadata types in second argument in the metadata-callback, DEFAULT: false
	 *
	 * @see Flac#setOptions
	 * @see Flac~metadata_callback_fn
	 * @see Flac#FLAC__stream_decoder_set_metadata_respond_all
	 */
	/**
	 * FLAC raw metadata
	 *
	 * @interface MetadataBlock
	 * @memberOf Flac
	 * @property {Flac.FLAC__MetadataType}  type the type of the metadata
	 * @property {boolean}  isLast if it is the last block of metadata
	 * @property {number}  length the length of the metadata block (bytes)
	 * @property {Flac.StreamMetadata | Flac.PaddingMetadata | Flac.ApplicationMetadata | Flac.SeekTableMetadata | Flac.CueSheetMetadata | Flac.PictureMetadata}  [data] the metadata (omitted for unknown metadata types)
	 * @property {Uint8Array}  [raw] raw metadata (for debugging: enable via {@link Flac#setOptions})
	 */
	/**
	 * FLAC padding metadata block
	 *
	 * @interface PaddingMetadata
	 * @memberOf Flac
	 * @property {number}  dummy Conceptually this is an empty struct since we don't store the padding bytes. Empty structs are not allowed by some C compilers, hence the dummy.
	 *
	 * @see Flac.FLAC__MetadataType#FLAC__METADATA_TYPE_PADDING
	 */
	/**
	 * FLAC application metadata block
	 *
	 * NOTE the application meta data type is not really supported, i.e. the
	 *      (binary) data is only a pointer to the memory heap.
	 *
	 * @interface ApplicationMetadata
	 * @memberOf Flac
	 * @property {number}  id the application ID
	 * @property {number}  data (pointer)
	 *
	 * @see Flac.FLAC__MetadataType#FLAC__METADATA_TYPE_APPLICATION
	 * @see <a href="https://xiph.org/flac/format.html#metadata_block_application">application block format specification</a>
	 */
	/**
	 * FLAC seek table metadata block
	 *
	 * <p>
	 * From the format specification:
	 *
	 * The seek points must be sorted by ascending sample number.
	 *
	 * Each seek point's sample number must be the first sample of the target frame.
	 *
	 * Each seek point's sample number must be unique within the table
	 *
	 * Existence of a SEEKTABLE block implies a correct setting of total_samples in the stream_info block.
	 *
	 * Behavior is undefined when more than one SEEKTABLE block is present in a stream.
	 *
	 * @interface SeekTableMetadata
	 * @memberOf Flac
	 * @property {number}  num_points the number of seek points
	 * @property {Flac.SeekPoint[]}  points the seek points
	 *
	 * @see Flac.FLAC__MetadataType#FLAC__METADATA_TYPE_SEEKTABLE
	 */
	/**
	 * FLAC seek point data
	 *
	 * @interface SeekPoint
	 * @memberOf Flac
	 * @property {number}  sample_number The sample number of the target frame. NOTE <code>-1</code> for a placeholder point.
	 * @property {number}  stream_offset The offset, in bytes, of the target frame with respect to beginning of the first frame.
	 * @property {number}  frame_samples The number of samples in the target frame.
	 *
	 * @see Flac.SeekTableMetadata
	 */
	/**
	 * FLAC vorbis comment metadata block
	 *
	 * @interface VorbisCommentMetadata
	 * @memberOf Flac
	 * @property {string}  vendor_string the vendor string
	 * @property {number}  num_comments the number of comments
	 * @property {string[]}  comments the comments
	 *
	 * @see Flac.FLAC__MetadataType#FLAC__METADATA_TYPE_VORBIS_COMMENT
	 */
	 /**
	 * FLAC cue sheet metadata block
	 *
	 * @interface CueSheetMetadata
	 * @memberOf Flac
	 * @property {string}  media_catalog_number Media catalog number, in ASCII printable characters 0x20-0x7e. In general, the media catalog number may be 0 to 128 bytes long.
	 * @property {number}  lead_in The number of lead-in samples.
	 * @property {boolean}  is_cd true if CUESHEET corresponds to a Compact Disc, else false.
	 * @property {number}  num_tracks The number of tracks.
	 * @property {Flac.CueSheetTrack[]}  tracks the tracks
	 *
	 * @see Flac.FLAC__MetadataType#FLAC__METADATA_TYPE_CUESHEET
	 */
	 /**
	 * FLAC cue sheet track data
	 *
	 * @interface CueSheetTrack
	 * @memberOf Flac
	 * @property {number}  offset Track offset in samples, relative to the beginning of the FLAC audio stream.
	 * @property {number}  number The track number.
	 * @property {string}  isrc Track ISRC. This is a 12-digit alphanumeric code.
	 * @property {"AUDIO" | "NON_AUDIO"}  type The track type: audio or non-audio.
	 * @property {boolean}  pre_emphasis The pre-emphasis flag
	 * @property {number}  num_indices The number of track index points.
	 * @property {Flac.CueSheetTracIndex}  indices The track index points.
	 *
	 * @see Flac.CueSheetMetadata
	 */
	/**
	 * FLAC track index data for cue sheet metadata
	 *
	 * @interface CueSheetTracIndex
	 * @memberOf Flac
	 * @property {number}  offset Offset in samples, relative to the track offset, of the index point.
	 * @property {number}  number The index point number.
	 *
	 * @see Flac.CueSheetTrack
	 */
	/**
	 * FLAC picture metadata block
	 *
	 * @interface PictureMetadata
	 * @memberOf Flac
	 * @property {Flac.FLAC__StreamMetadata_Picture_Type}  type The kind of picture stored.
	 * @property {string}  mime_type Picture data's MIME type, in ASCII printable characters 0x20-0x7e, NUL terminated. For best compatibility with players, use picture data of MIME type image/jpeg or image/png. A MIME type of '–>' is also allowed, in which case the picture data should be a complete URL.
	 * @property {string}  description Picture's description.
	 * @property {number}  width Picture's width in pixels.
	 * @property {number}  height Picture's height in pixels.
	 * @property {number}  depth Picture's color depth in bits-per-pixel.
	 * @property {number}  colors For indexed palettes (like GIF), picture's number of colors (the number of palette entries), or 0 for non-indexed (i.e. 2^depth).
	 * @property {number}  data_length Length of binary picture data in bytes.
	 * @property {Uint8Array}  data Binary picture data.
	 */
	/**
	 * An enumeration of the PICTURE types (see FLAC__StreamMetadataPicture and id3 v2.4 APIC tag).
	 *
	 * @interface FLAC__StreamMetadata_Picture_Type
	 * @memberOf Flac
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_OTHER"} 					0		Other
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_FILE_ICON_STANDARD"} 		1		32x32 pixels 'file icon' (PNG only)
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_FILE_ICON"} 				2		Other file icon
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_FRONT_COVER"} 			3		Cover (front)
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_BACK_COVER"} 				4		Cover (back)
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_LEAFLET_PAGE"} 			5		Leaflet page
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_MEDIA"} 					6		Media (e.g. label side of CD)
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_LEAD_ARTIST"} 			7		Lead artist/lead performer/soloist
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_ARTIST"} 					8		Artist/performer
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_CONDUCTOR"} 				9		Conductor
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_BAND"} 					10		Band/Orchestra
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_COMPOSER"} 				11		Composer
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_LYRICIST"} 				12		Lyricist/text writer
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_RECORDING_LOCATION"} 		13		Recording Location
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_DURING_RECORDING"} 		14		During recording
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_DURING_PERFORMANCE"} 		15		During performance
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_VIDEO_SCREEN_CAPTURE"} 	16		Movie/video screen capture
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_FISH"} 					17		A bright coloured fish
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_ILLUSTRATION"} 			18		Illustration
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_BAND_LOGOTYPE"} 			19		Band/artist logotype
	 * @property {"FLAC__STREAM_METADATA_PICTURE_TYPE_PUBLISHER_LOGOTYPE"} 		20		Publisher/Studio logotype
	 *
	 * @see Flac.PictureMetadata
	 */

	/**
	 * An enumeration of the available metadata block types.
	 *
	 * @interface FLAC__MetadataType
	 * @memberOf Flac
	 *
	 * @property {"FLAC__METADATA_TYPE_STREAMINFO"} 		0	STREAMINFO block
	 * @property {"FLAC__METADATA_TYPE_PADDING"} 			1	PADDING block
	 * @property {"FLAC__METADATA_TYPE_APPLICATION"} 		2	APPLICATION block
	 * @property {"FLAC__METADATA_TYPE_SEEKTABLE"} 			3	SEEKTABLE block
	 * @property {"FLAC__METADATA_TYPE_VORBIS_COMMENT"} 	4	VORBISCOMMENT block (a.k.a. FLAC tags)
	 * @property {"FLAC__METADATA_TYPE_CUESHEET"} 			5	CUESHEET block
	 * @property {"FLAC__METADATA_TYPE_PICTURE"} 			6	PICTURE block
	 * @property {"FLAC__METADATA_TYPE_UNDEFINED"} 			7	marker to denote beginning of undefined type range; this number will increase as new metadata types are added
	 * @property {"FLAC__MAX_METADATA_TYPE"} 				126	No type will ever be greater than this. There is not enough room in the protocol block.
	 *
	 * @see Flac.MetadataBlock
	 * @see <a href="https://xiph.org/flac/format.html">FLAC format documentation</a>
	 */
	/**
	 * @function
	 * @public
	 * @memberOf Flac#
	 * @copydoc Flac._setOptions
	 */
	setOptions: _setOptions,
	/**
	 * @function
	 * @public
	 * @memberOf Flac#
	 * @copydoc Flac._getOptions
	 */
	getOptions: _getOptions,
	/**
	 * Returns if Flac has been initialized / is ready to be used.
	 *
	 * @returns {boolean} <code>true</code>, if Flac is ready to be used
	 *
	 * @memberOf Flac#
	 * @function
	 * @see #onready
	 * @see #on
	 */
	isReady: function() { return _flac_ready; },
	/**
	 * Hook for handler function that gets called, when asynchronous initialization has finished.
	 *
	 * NOTE that if the execution environment does not support <code>Object#defineProperty</code>, then
	 *      this function is not called, after {@link #isReady} is <code>true</code>.
	 *      In this case, {@link #isReady} should be checked, before setting <code>onready</code>
	 *      and if it is <code>true</code>, handler should be executed immediately instead of setting <code>onready</code>.
	 *
	 * @memberOf Flac#
	 * @function
	 * @param {Flac.event:ReadyEvent} event the ready-event object
	 * @see #isReady
	 * @see #on
	 * @default undefined
	 * @example
	 *  // [1] if Object.defineProperty() IS supported:
	 *  Flac.onready = function(event){
	 *     //gets executed when library becomes ready, or immediately, if it already is ready...
	 *	   doSomethingWithFlac();
	 *  };
	 *
	 *  // [2] if Object.defineProperty() is NOT supported:
	 *	// do check Flac.isReady(), and only set handler, if not ready yet
	 *  // (otherwise immediately excute handler code)
	 *  if(!Flac.isReady()){
	 *    Flac.onready = function(event){
	 *       //gets executed when library becomes ready...
	 *		 doSomethingWithFlac();
	 *    };
	 *  } else {
	 * 		// Flac is already ready: immediately start processing
	 *		doSomethingWithFlac();
	 *	}
	 */
	onready: void(0),
	/**
	 * Ready event: is fired when the library has been initialized and is ready to be used
	 * (e.g. asynchronous loading of binary / WASM modules has been completed).
	 *
	 * Before this event is fired, use of functions related to encoding and decoding may
	 * cause errors.
	 *
	 * @event ReadyEvent
	 * @memberOf Flac
	 * @type {object}
	 * @property {"ready"} type 	the type of the event <code>"ready"</code>
	 * @property {Flac} target 	the initalized FLAC library instance
	 *
	 * @see #isReady
	 * @see #on
	 */
	/**
	 * Created event: is fired when an encoder or decoder was created.
	 *
	 * @event CreatedEvent
	 * @memberOf Flac
	 * @type {object}
	 * @property {"created"} type 	the type of the event <code>"created"</code>
	 * @property {Flac.CoderChangedEventData} target 	the information for the created encoder or decoder
	 *
	 * @see #on
	 */
	/**
	 * Destroyed event: is fired when an encoder or decoder was destroyed.
	 *
	 * @event DestroyedEvent
	 * @memberOf Flac
	 * @type {object}
	 * @property {"destroyed"} type 	the type of the event <code>"destroyed"</code>
	 * @property {Flac.CoderChangedEventData} target 	the information for the destroyed encoder or decoder
	 *
	 * @see #on
	 */
	/**
	 * Life cycle event data for signaling life cycle changes of encoder or decoder instances
	 * @interface CoderChangedEventData
	 * @memberOf Flac
	 * @property {number}  id  the ID for the encoder or decoder instance
	 * @property {"encoder" | "decoder"}  type  signifies whether the event is for an encoder or decoder instance
	 * @property {any}  [data]  specific data for the life cycle change
	 *
	 * @see Flac.event:CreatedEvent
	 * @see Flac.event:DestroyedEvent
	 */
	/**
	 * Add an event listener for module-events.
	 * Supported events:
	 * <ul>
	 *  <li> <code>"ready"</code> &rarr; {@link Flac.event:ReadyEvent}: emitted when module is ready for usage (i.e. {@link #isReady} is true)<br/>
	 *             <em>NOTE listener will get immediately triggered if module is already <code>"ready"</code></em>
	 *  </li>
	 *  <li> <code>"created"</code> &rarr; {@link Flac.event:CreatedEvent}: emitted when an encoder or decoder instance was created<br/>
	 *  </li>
	 *  <li> <code>"destroyed"</code> &rarr; {@link Flac.event:DestroyedEvent}: emitted when an encoder or decoder instance was destroyed<br/>
	 *  </li>
	 * </ul>
	 *
	 * @param {string} eventName
	 * @param {Function} listener
	 *
	 * @memberOf Flac#
	 * @function
	 * @see #off
	 * @see #onready
	 * @see Flac.event:ReadyEvent
	 * @see Flac.event:CreatedEvent
	 * @see Flac.event:DestroyedEvent
	 * @example
	 *  Flac.on('ready', function(event){
	 *     //gets executed when library is ready, or becomes ready...
	 *  });
	 */
	on: add_event_listener,
	/**
	 * Remove an event listener for module-events.
	 * @param {string} eventName
	 * @param {Function} listener
	 *
	 * @memberOf Flac#
	 * @function
	 * @see #on
	 */
	off: remove_event_listener,

	/**
	 * Set the "verify" flag. If true, the encoder will verify it's own encoded output by feeding it through an internal decoder and comparing the original signal against the decoded signal. If a mismatch occurs, the process call will return false. Note that this will slow the encoding process by the extra time required for decoding and comparison.
	 *
	 * <p>
	 * NOTE: only use on un-initilized encoder instances!
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @param {boolean} is_verify enable/disable checksum verification during encoding
	 *
	 * @returns {boolean} <code>false</code> if the encoder is already initialized, else <code>true</code>
	 *
	 * @see #create_libflac_encoder
	 * @see #FLAC__stream_encoder_get_verify
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_encoder_set_verify: function(encoder, is_verify){
		is_verify = is_verify? 1 : 0;
		Module.ccall('FLAC__stream_encoder_set_verify', 'number', ['number', 'number'], [ encoder, is_verify ]);
	},
	/**
	 * Set the compression level
	 *
	 * The compression level is roughly proportional to the amount of effort the encoder expends to compress the file. A higher level usually means more computation but higher compression. The default level is suitable for most applications.
	 *
	 * Currently the levels range from 0 (fastest, least compression) to 8 (slowest, most compression). A value larger than 8 will be treated as 8.
	 *
	 *
	 * <p>
	 * NOTE: only use on un-initilized encoder instances!
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @param {Flac.CompressionLevel} compression_level the desired Flac compression level: [0, 8]
	 *
	 * @returns {boolean} <code>false</code> if the encoder is already initialized, else <code>true</code>
	 *
	 * @see #create_libflac_encoder
	 * @see Flac.CompressionLevel
	 * @see <a href="https://xiph.org/flac/api/group__flac__stream__encoder.html#gae49cf32f5256cb47eecd33779493ac85">FLAC API for FLAC__stream_encoder_set_compression_level()</a>
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_encoder_set_compression_level: Module.cwrap('FLAC__stream_encoder_set_compression_level', 'number', [ 'number', 'number' ]),
	/**
	 * Set the blocksize to use while encoding.
	 * The number of samples to use per frame. Use 0 to let the encoder estimate a blocksize; this is usually best.
	 *
	 * <p>
	 * NOTE: only use on un-initilized encoder instances!
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @param {number} block_size  the number of samples to use per frame
	 *
	 * @returns {boolean} <code>false</code> if the encoder is already initialized, else <code>true</code>
	 *
	 * @see #create_libflac_encoder
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_encoder_set_blocksize: Module.cwrap('FLAC__stream_encoder_set_blocksize', 'number', [ 'number', 'number']),


	/**
	 * Get the state of the verify stream decoder. Useful when the stream encoder state is FLAC__STREAM_ENCODER_VERIFY_DECODER_ERROR.
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @returns {Flac.FLAC__StreamDecoderState} the verify stream decoder state
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_encoder_get_verify_decoder_state: Module.cwrap('FLAC__stream_encoder_get_verify_decoder_state', 'number', ['number']),

	/**
	 * Get the "verify" flag for the encoder.
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @returns {boolean} the verify flag for the encoder
	 *
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see #FLAC__stream_encoder_set_verify
	 */
	FLAC__stream_encoder_get_verify: Module.cwrap('FLAC__stream_encoder_get_verify', 'number', ['number']),
/*

TODO export other encoder API functions?:

FLAC__bool 	FLAC__stream_encoder_set_channels (FLAC__StreamEncoder *encoder, unsigned value)

FLAC__bool 	FLAC__stream_encoder_set_bits_per_sample (FLAC__StreamEncoder *encoder, unsigned value)

FLAC__bool 	FLAC__stream_encoder_set_sample_rate (FLAC__StreamEncoder *encoder, unsigned value)

FLAC__bool 	FLAC__stream_encoder_set_do_mid_side_stereo (FLAC__StreamEncoder *encoder, FLAC__bool value)

FLAC__bool 	FLAC__stream_encoder_set_loose_mid_side_stereo (FLAC__StreamEncoder *encoder, FLAC__bool value)

FLAC__bool 	FLAC__stream_encoder_set_apodization (FLAC__StreamEncoder *encoder, const char *specification)

FLAC__bool 	FLAC__stream_encoder_set_max_lpc_order (FLAC__StreamEncoder *encoder, unsigned value)

FLAC__bool 	FLAC__stream_encoder_set_qlp_coeff_precision (FLAC__StreamEncoder *encoder, unsigned value)

FLAC__bool 	FLAC__stream_encoder_set_do_qlp_coeff_prec_search (FLAC__StreamEncoder *encoder, FLAC__bool value)

FLAC__bool 	FLAC__stream_encoder_set_do_escape_coding (FLAC__StreamEncoder *encoder, FLAC__bool value)

FLAC__bool 	FLAC__stream_encoder_set_do_exhaustive_model_search (FLAC__StreamEncoder *encoder, FLAC__bool value)

FLAC__bool 	FLAC__stream_encoder_set_min_residual_partition_order (FLAC__StreamEncoder *encoder, unsigned value)

FLAC__bool 	FLAC__stream_encoder_set_max_residual_partition_order (FLAC__StreamEncoder *encoder, unsigned value)

FLAC__bool 	FLAC__stream_encoder_set_rice_parameter_search_dist (FLAC__StreamEncoder *encoder, unsigned value)

FLAC__bool 	FLAC__stream_encoder_get_streamable_subset (const FLAC__StreamEncoder *encoder)

unsigned 	FLAC__stream_encoder_get_channels (const FLAC__StreamEncoder *encoder)

unsigned 	FLAC__stream_encoder_get_bits_per_sample (const FLAC__StreamEncoder *encoder)

unsigned 	FLAC__stream_encoder_get_sample_rate (const FLAC__StreamEncoder *encoder)

unsigned 	FLAC__stream_encoder_get_blocksize (const FLAC__StreamEncoder *encoder)

FLAC__bool 	FLAC__stream_encoder_get_do_mid_side_stereo (const FLAC__StreamEncoder *encoder)

FLAC__bool 	FLAC__stream_encoder_get_loose_mid_side_stereo (const FLAC__StreamEncoder *encoder)

unsigned 	FLAC__stream_encoder_get_max_lpc_order (const FLAC__StreamEncoder *encoder)

unsigned 	FLAC__stream_encoder_get_qlp_coeff_precision (const FLAC__StreamEncoder *encoder)

FLAC__bool 	FLAC__stream_encoder_get_do_qlp_coeff_prec_search (const FLAC__StreamEncoder *encoder)

FLAC__bool 	FLAC__stream_encoder_get_do_escape_coding (const FLAC__StreamEncoder *encoder)

FLAC__bool 	FLAC__stream_encoder_get_do_exhaustive_model_search (const FLAC__StreamEncoder *encoder)

unsigned 	FLAC__stream_encoder_get_min_residual_partition_order (const FLAC__StreamEncoder *encoder)

unsigned 	FLAC__stream_encoder_get_max_residual_partition_order (const FLAC__StreamEncoder *encoder)

unsigned 	FLAC__stream_encoder_get_rice_parameter_search_dist (const FLAC__StreamEncoder *encoder)

FLAC__uint64 	FLAC__stream_encoder_get_total_samples_estimate (const FLAC__StreamEncoder *encoder)



TODO export other decoder API functions?:


const char * 	FLAC__stream_decoder_get_resolved_state_string (const FLAC__StreamDecoder *decoder)

FLAC__uint64 	FLAC__stream_decoder_get_total_samples (const FLAC__StreamDecoder *decoder)

unsigned 	FLAC__stream_decoder_get_channels (const FLAC__StreamDecoder *decoder)

unsigned 	FLAC__stream_decoder_get_bits_per_sample (const FLAC__StreamDecoder *decoder)

unsigned 	FLAC__stream_decoder_get_sample_rate (const FLAC__StreamDecoder *decoder)

unsigned 	FLAC__stream_decoder_get_blocksize (const FLAC__StreamDecoder *decoder)


FLAC__bool 	FLAC__stream_decoder_flush (FLAC__StreamDecoder *decoder)

FLAC__bool 	FLAC__stream_decoder_skip_single_frame (FLAC__StreamDecoder *decoder)

 */

	 /**
	 * Set the compression level
	 *
	 * The compression level is roughly proportional to the amount of effort the encoder expends to compress the file. A higher level usually means more computation but higher compression. The default level is suitable for most applications.
	 *
	 * Currently the levels range from 0 (fastest, least compression) to 8 (slowest, most compression). A value larger than 8 will be treated as 8.
	 *
	 * This function automatically calls the following other set functions with appropriate values, so the client does not need to unless it specifically wants to override them:
	 * <pre>
	 *     FLAC__stream_encoder_set_do_mid_side_stereo()
	 *     FLAC__stream_encoder_set_loose_mid_side_stereo()
	 *     FLAC__stream_encoder_set_apodization()
	 *     FLAC__stream_encoder_set_max_lpc_order()
	 *     FLAC__stream_encoder_set_qlp_coeff_precision()
	 *     FLAC__stream_encoder_set_do_qlp_coeff_prec_search()
	 *     FLAC__stream_encoder_set_do_escape_coding()
	 *     FLAC__stream_encoder_set_do_exhaustive_model_search()
	 *     FLAC__stream_encoder_set_min_residual_partition_order()
	 *     FLAC__stream_encoder_set_max_residual_partition_order()
	 *     FLAC__stream_encoder_set_rice_parameter_search_dist()
	 * </pre>
	 * The actual values set for each level are:
	 * | level  | do mid-side stereo  | loose mid-side stereo  | apodization                                    | max lpc order  | qlp coeff precision  | qlp coeff prec search  | escape coding  | exhaustive model search  | min residual partition order  | max residual partition order  | rice parameter search dist   |
	 * |--------|---------------------|------------------------|------------------------------------------------|----------------|----------------------|------------------------|----------------|--------------------------|-------------------------------|-------------------------------|------------------------------|
	 * | 0      | false               | false                  | tukey(0.5)                                     | 0              | 0                    | false                  | false          | false                    | 0                             | 3                             | 0                            |
	 * | 1      | true                | true                   | tukey(0.5)                                     | 0              | 0                    | false                  | false          | false                    | 0                             | 3                             | 0                            |
	 * | 2      | true                | false                  | tukey(0.5)                                     | 0              | 0                    | false                  | false          | false                    | 0                             | 3                             | 0                            |
	 * | 3      | false               | false                  | tukey(0.5)                                     | 6              | 0                    | false                  | false          | false                    | 0                             | 4                             | 0                            |
	 * | 4      | true                | true                   | tukey(0.5)                                     | 8              | 0                    | false                  | false          | false                    | 0                             | 4                             | 0                            |
	 * | 5      | true                | false                  | tukey(0.5)                                     | 8              | 0                    | false                  | false          | false                    | 0                             | 5                             | 0                            |
	 * | 6      | true                | false                  | tukey(0.5);partial_tukey(2)                    | 8              | 0                    | false                  | false          | false                    | 0                             | 6                             | 0                            |
	 * | 7      | true                | false                  | tukey(0.5);partial_tukey(2)                    | 12             | 0                    | false                  | false          | false                    | 0                             | 6                             | 0                            |
	 * | 8      | true                | false                  | tukey(0.5);partial_tukey(2);punchout_tukey(3)  | 12             | 0                    | false                  | false          | false                    | 0                             | 6                             | 0                            |
	 *
	 * @interface CompressionLevel
	 * @memberOf Flac
	 *
	 * @property {"FLAC__COMPRESSION_LEVEL_0"} 		0	compression level 0
	 * @property {"FLAC__COMPRESSION_LEVEL_1"} 		1	compression level 1
	 * @property {"FLAC__COMPRESSION_LEVEL_2"} 		2	compression level 2
	 * @property {"FLAC__COMPRESSION_LEVEL_3"} 		3	compression level 3
	 * @property {"FLAC__COMPRESSION_LEVEL_4"} 		4	compression level 4
	 * @property {"FLAC__COMPRESSION_LEVEL_5"} 		5	compression level 5
	 * @property {"FLAC__COMPRESSION_LEVEL_6"} 		6	compression level 6
	 * @property {"FLAC__COMPRESSION_LEVEL_7"} 		7	compression level 7
	 * @property {"FLAC__COMPRESSION_LEVEL_8"} 		8	compression level 8
	 */
	/**
	 * Create an encoder.
	 *
	 * @param {number} sample_rate
	 * 					the sample rate of the input PCM data
	 * @param {number} channels
	 * 					the number of channels of the input PCM data
	 * @param {number} bps
	 * 					bits per sample of the input PCM data
	 * @param {Flac.CompressionLevel} compression_level
	 * 					the desired Flac compression level: [0, 8]
	 * @param {number} [total_samples] OPTIONAL
	 * 					the number of total samples of the input PCM data:<br>
	 * 					 Sets an estimate of the total samples that will be encoded.
	 * 					 This is merely an estimate and may be set to 0 if unknown.
	 * 					 This value will be written to the STREAMINFO block before encoding,
	 * 					 and can remove the need for the caller to rewrite the value later if
	 * 					 the value is known before encoding.<br>
	 * 					If specified, the it will be written into metadata of the FLAC header.<br>
	 * 					DEFAULT: 0 (i.e. unknown number of samples)
	 * @param {boolean} [is_verify] OPTIONAL
	 * 					enable/disable checksum verification during encoding<br>
	 * 					DEFAULT: true<br>
	 * 					NOTE: this argument is positional (i.e. total_samples must also be given)
	 * @param {number} [block_size] OPTIONAL
	 * 					the number of samples to use per frame.<br>
	 * 					DEFAULT: 0 (i.e. encoder sets block size automatically)
	 * 					NOTE: this argument is positional (i.e. total_samples and is_verify must also be given)
	 *
	 *
	 * @returns {number} the ID of the created encoder instance (or 0, if there was an error)
	 *
	 * @memberOf Flac#
	 * @function
	 */
	create_libflac_encoder: function(sample_rate, channels, bps, compression_level, total_samples, is_verify, block_size){
		is_verify = typeof is_verify === 'undefined'? 1 : is_verify + 0;
		total_samples = typeof total_samples === 'number'? total_samples : 0;
		block_size = typeof block_size === 'number'? block_size : 0;
		var ok = true;
		var encoder = Module.ccall('FLAC__stream_encoder_new', 'number', [ ], [ ]);
		ok &= Module.ccall('FLAC__stream_encoder_set_verify', 'number', ['number', 'number'], [ encoder, is_verify ]);
		ok &= Module.ccall('FLAC__stream_encoder_set_compression_level', 'number', ['number', 'number'], [ encoder, compression_level ]);
		ok &= Module.ccall('FLAC__stream_encoder_set_channels', 'number', ['number', 'number'], [ encoder, channels ]);
		ok &= Module.ccall('FLAC__stream_encoder_set_bits_per_sample', 'number', ['number', 'number'], [ encoder, bps ]);
		ok &= Module.ccall('FLAC__stream_encoder_set_sample_rate', 'number', ['number', 'number'], [ encoder, sample_rate ]);
		ok &= Module.ccall('FLAC__stream_encoder_set_blocksize', 'number', [ 'number', 'number'], [ encoder, block_size ]);
		ok &= Module.ccall('FLAC__stream_encoder_set_total_samples_estimate', 'number', ['number', 'number'], [ encoder, total_samples ]);
		if (ok){
			do_fire_event('created', [{type: 'created', target: {id: encoder, type: 'encoder'}}], false);
			return encoder;
		}
		return 0;
	},
	/**
	 * @deprecated use {@link #create_libflac_encoder} instead
	 * @memberOf Flac#
	 * @function
	 */
	init_libflac_encoder: function(){
		console.warn('Flac.init_libflac_encoder() is deprecated, use Flac.create_libflac_encoder() instead!');
		return this.create_libflac_encoder.apply(this, arguments);
	},

	/**
	 * Create a decoder.
	 *
	 * @param {boolean} [is_verify]
	 * 				enable/disable checksum verification during decoding<br>
	 * 				DEFAULT: true
	 *
	 * @returns {number} the ID of the created decoder instance (or 0, if there was an error)
	 *
	 * @memberOf Flac#
	 * @function
	 */
	create_libflac_decoder: function(is_verify){
		is_verify = typeof is_verify === 'undefined'? 1 : is_verify + 0;
		var ok = true;
		var decoder = Module.ccall('FLAC__stream_decoder_new', 'number', [ ], [ ]);
		ok &= Module.ccall('FLAC__stream_decoder_set_md5_checking', 'number', ['number', 'number'], [ decoder, is_verify ]);
		if (ok){
			do_fire_event('created', [{type: 'created', target: {id: decoder, type: 'decoder'}}], false);
			return decoder;
		}
		return 0;
	},
	/**
	 * @deprecated use {@link #create_libflac_decoder} instead
	 * @memberOf Flac#
	 * @function
	 */
	init_libflac_decoder: function(){
		console.warn('Flac.init_libflac_decoder() is deprecated, use Flac.create_libflac_decoder() instead!');
		return this.create_libflac_decoder.apply(this, arguments);
	},
	/**
	 * The callback for writing the encoded FLAC data.
	 *
	 * @callback Flac~encoder_write_callback_fn
	 * @param {Uint8Array} data the encoded FLAC data
	 * @param {number} numberOfBytes the number of bytes in data
	 * @param {number} samples the number of samples encoded in data
	 * @param {number} currentFrame the number of the (current) encoded frame in data
	 * @returns {void | false} returning <code>false</code> indicates that an
	 * 								unrecoverable error occurred and decoding should be aborted
	 */
	/**
	 * The callback for the metadata of the encoded/decoded Flac data.
	 *
	 * By default, only the STREAMINFO metadata is enabled.
	 *
	 * For other metadata types {@link Flac.FLAC__MetadataType} they need to be enabled,
	 * see e.g. {@link Flac#FLAC__stream_decoder_set_metadata_respond}
	 *
	 * @callback Flac~metadata_callback_fn
	 * @param {Flac.StreamMetadata | undefined} metadata the FLAC meta data, NOTE only STREAMINFO is returned in first argument, for other types use 2nd argument's <code>metadataBlock.data<code>
	 * @param {Flac.MetadataBlock} metadataBlock the detailed meta data block
	 *
	 * @see Flac#init_decoder_stream
	 * @see Flac#init_encoder_stream
	 * @see Flac.CodingOptions
	 * @see Flac#FLAC__stream_decoder_set_metadata_respond_all
	 */
	/**
	 * FLAC meta data
	 * @interface Metadata
	 * @memberOf Flac
	 * @property {number}  sampleRate the sample rate (Hz)
	 * @property {number}  channels the number of channels
	 * @property {number}  bitsPerSample bits per sample
	 */
	/**
	 * FLAC stream meta data
	 * @interface StreamMetadata
	 * @memberOf Flac
	 * @augments Flac.Metadata
	 * @property {number}  min_blocksize the minimal block size (bytes)
	 * @property {number}  max_blocksize the maximal block size (bytes)
	 * @property {number}  min_framesize the minimal frame size (bytes)
	 * @property {number}  max_framesize the maximal frame size (bytes)
	 * @property {number}  total_samples the total number of (encoded/decoded) samples
	 * @property {string}  md5sum  the MD5 checksum for the decoded data (if validation is active)
	 */
	/**
	 * Initialize the encoder.
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance that has not been initialized (or has been reset)
	 *
	 * @param {Flac~encoder_write_callback_fn} write_callback_fn
	 * 				the callback for writing the encoded Flac data:
	 * 				<pre>write_callback_fn(data: Uint8Array, numberOfBytes: Number, samples: Number, currentFrame: Number)</pre>
	 *
	 * @param {Flac~metadata_callback_fn} [metadata_callback_fn] OPTIONAL
	 * 				the callback for the metadata of the encoded Flac data:
	 * 				<pre>metadata_callback_fn(metadata: StreamMetadata)</pre>
	 *
	 * @param {number|boolean} [ogg_serial_number] OPTIONAL
	 * 				if number or <code>true</code> is specified, the encoder will be initialized to
	 * 				write to an OGG container, see {@link Flac.init_encoder_ogg_stream}:
	 * 				<code>true</code> will set a default serial number (<code>1</code>),
	 * 				if specified as number, it will be used as the stream's serial number within the ogg container.
	 *
	 * @returns {Flac.FLAC__StreamEncoderInitStatus} the encoder status (<code>0</code> for <code>FLAC__STREAM_ENCODER_INIT_STATUS_OK</code>)
	 *
	 * @memberOf Flac#
	 * @function
	 */
	init_encoder_stream: function(encoder, write_callback_fn, metadata_callback_fn, ogg_serial_number, client_data){

		var is_ogg = (ogg_serial_number === true);
		client_data = client_data|0;

		if(typeof write_callback_fn !== 'function'){
			return FLAC__STREAM_ENCODER_INIT_STATUS_INVALID_CALLBACKS;
		}
		setCallback(encoder, 'write', write_callback_fn);

		var __metadata_callback_fn_ptr = 0;
		if(typeof metadata_callback_fn === 'function'){
			setCallback(encoder, 'metadata', metadata_callback_fn);
			__metadata_callback_fn_ptr = metadata_fn_ptr;
		}

		//NOTE the following comments are used for auto-detecting exported functions (only change if ccall function name(s) change!):
		//	Module.ccall('FLAC__stream_encoder_init_stream'
		var func_name = 'FLAC__stream_encoder_init_stream';
		var args_types = ['number', 'number', 'number', 'number', 'number', 'number'];
		var args = [
			encoder,
			enc_write_fn_ptr,
			0,//	FLAC__StreamEncoderSeekCallback
			0,//	FLAC__StreamEncoderTellCallback
			__metadata_callback_fn_ptr,
			client_data
		];

		if(typeof ogg_serial_number === 'number'){

			is_ogg = true;

		} else if(is_ogg){//else: set default serial number for stream in OGG container

			//NOTE from FLAC docs: "It is recommended to set a serial number explicitly as the default of '0' may collide with other streams."
			ogg_serial_number = 1;
		}

		if(is_ogg){
			//NOTE the following comments are used for auto-detecting exported functions (only change if ccall function name(s) change!):
			//	Module.ccall('FLAC__stream_encoder_init_ogg_stream'
			func_name = 'FLAC__stream_encoder_init_ogg_stream';

			//2nd arg: FLAC__StreamEncoderReadCallback ptr -> duplicate first entry & insert at [1]
			args.unshift(args[0]);
			args[1] = 0;//	FLAC__StreamEncoderReadCallback

			args_types.unshift(args_types[0]);
			args_types[1] = 'number';


			//NOTE ignore BOOL return value when setting serial number, since init-call's returned
			//     status will also indicate, if encoder already has been initialized
			Module.ccall(
				'FLAC__stream_encoder_set_ogg_serial_number', 'number',
				['number', 'number'],
				[ encoder, ogg_serial_number ]
			);
		}

		var init_status = Module.ccall(func_name, 'number', args_types, args);

		return init_status;
	},
	/**
	 * Initialize the encoder for writing to an OGG container.
	 *
	 * @param {number} [ogg_serial_number] OPTIONAL
	 * 				the serial number for the stream in the OGG container
	 * 				DEFAULT: <code>1</code>
	 *
	 * @memberOf Flac#
	 * @function
	 * @copydoc #init_encoder_stream
	 */
	init_encoder_ogg_stream: function(encoder, write_callback_fn, metadata_callback_fn, ogg_serial_number, client_data){

		if(typeof ogg_serial_number !== 'number'){
			ogg_serial_number = true;
		}
		return this.init_encoder_stream(encoder, write_callback_fn, metadata_callback_fn, ogg_serial_number, client_data);
	},
	/**
	 * Result / return value for {@link Flac~decoder_read_callback_fn} callback function
	 *
	 * @interface ReadResult
	 * @memberOf Flac
	 * @property {TypedArray}  buffer  a TypedArray (e.g. Uint8Array) with the read data
	 * @property {number}  readDataLength the number of read data bytes. A number of <code>0</code> (zero) indicates that the end-of-stream is reached.
	 * @property {boolean}  [error] OPTIONAL value of <code>true</code> indicates that an error occured (decoding will be aborted)
	 */
	/**
	 * Result / return value for {@link Flac~decoder_read_callback_fn} callback function for signifying that there is no more data to read
	 *
	 * @interface CompletedReadResult
	 * @memberOf Flac
	 * @augments Flac.ReadResult
	 * @property {TypedArray | undefined}  buffer  a TypedArray (e.g. Uint8Array) with the read data (will be ignored in case readDataLength is <code>0</code>)
	 * @property {0}  readDataLength the number of read data bytes: The number of <code>0</code> (zero) indicates that the end-of-stream is reached.
	 */
	/**
	 * The callback for reading the FLAC data that will be decoded.
	 *
	 * @callback Flac~decoder_read_callback_fn
	 * @param {number} numberOfBytes the maximal number of bytes that the read callback can return
	 * @returns {Flac.ReadResult | Flac.CompletedReadResult} the result of the reading action/request
	 */
	/**
	 * The callback for writing the decoded FLAC data.
	 *
	 * @callback Flac~decoder_write_callback_fn
	 * @param {Uint8Array[]} data array of the channels with the decoded PCM data as <code>Uint8Array</code>s
	 * @param {Flac.BlockMetadata} frameInfo the metadata information for the decoded data
	 */
	/**
	 * The callback for reporting decoding errors.
	 *
	 * @callback Flac~decoder_error_callback_fn
	 * @param {number} errorCode the error code
	 * @param {Flac.FLAC__StreamDecoderErrorStatus} errorDescription the string representation / description of the error
	 */
	/**
	 * FLAC block meta data
	 * @interface BlockMetadata
	 * @augments Flac.Metadata
	 * @memberOf Flac
	 *
	 * @property {number}  blocksize the block size (bytes)
	 * @property {number}  number the number of the decoded samples or frames
	 * @property {string}  numberType the type to which <code>number</code> refers to: either <code>"frames"</code> or <code>"samples"</code>
	 * @property {Flac.FLAC__ChannelAssignment} channelAssignment the channel assignment
	 * @property {string}  crc the MD5 checksum for the decoded data, if validation is enabled
	 * @property {Flac.SubFrameMetadata[]}  [subframes] the metadata of the subframes. The array length corresponds to the number of channels. NOTE will only be included if {@link Flac.CodingOptions CodingOptions.analyseSubframes} is enabled for the decoder.
	 *
	 * @see Flac.CodingOptions
	 * @see Flac#setOptions
	 */
	/**
	 * FLAC subframe metadata
	 * @interface SubFrameMetadata
	 * @memberOf Flac
	 *
	 * @property {Flac.FLAC__SubframeType}  type the type of the subframe
	 * @property {number|Flac.FixedSubFrameData|Flac.LPCSubFrameData}  data the type specific metadata for subframe
	 * @property {number}  wastedBits the wasted bits-per-sample
	 */
	/**
	 * metadata for FIXED subframe type
	 * @interface FixedSubFrameData
	 * @memberOf Flac
	 *
	 * @property {number}  order  The polynomial order.
	 * @property {number[]}  warmup  Warmup samples to prime the predictor, length == order.
	 * @property {Flac.SubFramePartition}  partition  The residual coding method.
	 * @property {number[]}  [residual]  The residual signal, length == (blocksize minus order) samples.
	 * 									NOTE will only be included if {@link Flac.CodingOptions CodingOptions.analyseSubframes} is enabled for the decoder.
	 */
	/**
	 * metadata for LPC subframe type
	 * @interface LPCSubFrameData
	 * @augments Flac.FixedSubFrameData
	 * @memberOf Flac
	 *
	 * @property {number}  order  The FIR order.
	 * @property {number[]}  qlp_coeff  FIR filter coefficients.
	 * @property {number}  qlp_coeff_precision  Quantized FIR filter coefficient precision in bits.
	 * @property {number}  quantization_level The qlp coeff shift needed.
	 */
	/**
	 * metadata for FIXED or LPC subframe partitions
	 * @interface SubFramePartition
	 * @memberOf Flac
	 *
	 * @property {Flac.FLAC__EntropyCodingMethodType}  type  the entropy coding method
	 * @property {Flac.SubFramePartitionData}  data  metadata for a Rice partitioned residual
	 */
	/**
	 * metadata for FIXED or LPC subframe partition data
	 * @interface SubFramePartitionData
	 * @memberOf Flac
	 *
	 * @property {number}  order  The partition order, i.e. # of contexts = 2 ^ order.
	 * @property {Flac.SubFramePartitionContent}  contents  The context's Rice parameters and/or raw bits.
	 */
	/**
	 * metadata for FIXED or LPC subframe partition data content
	 * @interface SubFramePartitionContent
	 * @memberOf Flac
	 *
	 * @property {number[]}  parameters  The Rice parameters for each context.
	 * @property {number[]}  rawBits  Widths for escape-coded partitions. Will be non-zero for escaped partitions and zero for unescaped partitions.
	 * @property {number}  capacityByOrder  The capacity of the parameters and raw_bits arrays specified as an order, i.e. the number of array elements allocated is 2 ^ capacity_by_order.
	 */
	/**
	 * The types for FLAC subframes
	 *
	 * @interface FLAC__SubframeType
	 * @memberOf Flac
	 *
	 * @property {"FLAC__SUBFRAME_TYPE_CONSTANT"} 	0	constant signal
	 * @property {"FLAC__SUBFRAME_TYPE_VERBATIM"} 	1	uncompressed signal
	 * @property {"FLAC__SUBFRAME_TYPE_FIXED"} 		2	fixed polynomial prediction
	 * @property {"FLAC__SUBFRAME_TYPE_LPC"} 		3	linear prediction
	 */
	/**
	 * The channel assignment for the (decoded) frame.
	 *
	 * @interface FLAC__ChannelAssignment
	 * @memberOf Flac
	 *
	 * @property {"FLAC__CHANNEL_ASSIGNMENT_INDEPENDENT"} 		0	independent channels
	 * @property {"FLAC__CHANNEL_ASSIGNMENT_LEFT_SIDE"}  		1	left+side stereo
	 * @property {"FLAC__CHANNEL_ASSIGNMENT_RIGHT_SIDE"} 		2	right+side stereo
	 * @property {"FLAC__CHANNEL_ASSIGNMENT_MID_SIDE"}			3	mid+side stereo
	 */
	/**
	 * entropy coding methods
	 *
	 * @interface FLAC__EntropyCodingMethodType
	 * @memberOf Flac
	 *
	 * @property {"FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE"} 	0	Residual is coded by partitioning into contexts, each with it's own 4-bit Rice parameter.
	 * @property {"FLAC__ENTROPY_CODING_METHOD_PARTITIONED_RICE2"} 	1	Residual is coded by partitioning into contexts, each with it's own 5-bit Rice parameter.
	 */
	/**
	 * Initialize the decoder.
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance that has not been initialized (or has been reset)
	 *
	 * @param {Flac~decoder_read_callback_fn} read_callback_fn
	 * 				the callback for reading the Flac data that should get decoded:
	 * 				<pre>read_callback_fn(numberOfBytes: Number) : {buffer: ArrayBuffer, readDataLength: number, error: boolean}</pre>
	 *
	 * @param {Flac~decoder_write_callback_fn} write_callback_fn
	 * 				the callback for writing the decoded data:
	 * 				<pre>write_callback_fn(data: Uint8Array[], frameInfo: Metadata)</pre>
	 *
	 * @param {Flac~decoder_error_callback_fn} error_callback_fn
	 * 				the error callback:
	 * 				<pre>error_callback_fn(errorCode: Number, errorDescription: String)</pre>
	 *
	 * @param {Flac~metadata_callback_fn} [metadata_callback_fn] OPTIONAL
	 * 				callback for receiving the metadata of FLAC data that will be decoded:
	 * 				<pre>metadata_callback_fn(metadata: StreamMetadata)</pre>
	 *
	 * @param {number|boolean} [ogg_serial_number] OPTIONAL
	 * 				if number or <code>true</code> is specified, the decoder will be initilized to
	 * 				read from an OGG container, see {@link Flac.init_decoder_ogg_stream}:<br/>
	 * 				<code>true</code> will use the default serial number, if specified as number the
	 * 				corresponding stream with the serial number from the ogg container will be used.
	 *
	 * @returns {Flac.FLAC__StreamDecoderInitStatus} the decoder status(<code>0</code> for <code>FLAC__STREAM_DECODER_INIT_STATUS_OK</code>)
	 *
	 * @memberOf Flac#
	 * @function
	 */
	init_decoder_stream: function(decoder, read_callback_fn, write_callback_fn, error_callback_fn, metadata_callback_fn, ogg_serial_number, client_data){

		client_data = client_data|0;

		if(typeof read_callback_fn !== 'function'){
			return FLAC__STREAM_DECODER_INIT_STATUS_INVALID_CALLBACKS;
		}
		setCallback(decoder, 'read', read_callback_fn);

		if(typeof write_callback_fn !== 'function'){
			return FLAC__STREAM_DECODER_INIT_STATUS_INVALID_CALLBACKS;
		}
		setCallback(decoder, 'write', write_callback_fn);

		var __error_callback_fn_ptr = 0;
		if(typeof error_callback_fn === 'function'){
			setCallback(decoder, 'error', error_callback_fn);
			__error_callback_fn_ptr = dec_error_fn_ptr;
		}

		var __metadata_callback_fn_ptr = 0;
		if(typeof metadata_callback_fn === 'function'){
			setCallback(decoder, 'metadata', metadata_callback_fn);
			__metadata_callback_fn_ptr = metadata_fn_ptr;
		}

		var is_ogg = (ogg_serial_number === true);
		if(typeof ogg_serial_number === 'number'){

			is_ogg = true;

			//NOTE ignore BOOL return value when setting serial number, since init-call's returned
			//     status will also indicate, if decoder already has been initialized
			Module.ccall(
				'FLAC__stream_decoder_set_ogg_serial_number', 'number',
				['number', 'number'],
				[ decoder, ogg_serial_number ]
			);
		}

		//NOTE the following comments are used for auto-detecting exported functions (only change if ccall function name(s) change!):
		//	Module.ccall('FLAC__stream_decoder_init_stream'
		//	Module.ccall('FLAC__stream_decoder_init_ogg_stream'
		var init_func_name = !is_ogg? 'FLAC__stream_decoder_init_stream' : 'FLAC__stream_decoder_init_ogg_stream';

		var init_status = Module.ccall(
				init_func_name, 'number',
				[ 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
				[
					 decoder,
					 dec_read_fn_ptr,
					 0,// 	FLAC__StreamDecoderSeekCallback
					 0,// 	FLAC__StreamDecoderTellCallback
					 0,//	FLAC__StreamDecoderLengthCallback
					 0,//	FLAC__StreamDecoderEofCallback
					 dec_write_fn_ptr,
					 __metadata_callback_fn_ptr,
					 __error_callback_fn_ptr,
					 client_data
				]
		);

		return init_status;
	},
	/**
	 * Initialize the decoder for writing to an OGG container.
	 *
	 * @param {number} [ogg_serial_number] OPTIONAL
	 * 				the serial number for the stream in the OGG container that should be decoded.<br/>
	 * 				The default behavior is to use the serial number of the first Ogg page. Setting a serial number here will explicitly specify which stream is to be decoded.
	 *
	 * @memberOf Flac#
	 * @function
	 * @copydoc #init_decoder_stream
	 */
	init_decoder_ogg_stream: function(decoder, read_callback_fn, write_callback_fn, error_callback_fn, metadata_callback_fn, ogg_serial_number, client_data){

		if(typeof ogg_serial_number !== 'number'){
			ogg_serial_number = true;
		}
		return this.init_decoder_stream(decoder, read_callback_fn, write_callback_fn, error_callback_fn, metadata_callback_fn, ogg_serial_number, client_data);
	},
	/**
	 * Encode / submit data for encoding.
	 *
	 * This version allows you to supply the input data where the channels are interleaved into a
	 * single array (i.e. channel0_sample0, channel1_sample0, ... , channelN_sample0, channel0_sample1, ...).
	 *
	 * The samples need not be block-aligned but they must be sample-aligned, i.e. the first value should be
	 * channel0_sample0 and the last value channelN_sampleM.
	 *
	 * Each sample should be a signed integer, right-justified to the resolution set by bits-per-sample.
	 *
	 * For example, if the resolution is 16 bits per sample, the samples should all be in the range [-32768,32767].
	 *
	 *
	 * For applications where channel order is important, channels must follow the order as described in the frame header.
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @param {TypedArray} buffer
	 * 				the audio data in a typed array with signed integers (and size according to the set bits-per-sample setting)
	 *
	 * @param {number} num_of_samples
	 * 				the number of samples in buffer
	 *
	 * @returns {boolean} true if successful, else false; in this case, check the encoder state with FLAC__stream_encoder_get_state() to see what went wrong.
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_encoder_process_interleaved: function(encoder, buffer, num_of_samples){
		// get the length of the data in bytes
		var numBytes = buffer.length * buffer.BYTES_PER_ELEMENT;
		// malloc enough space for the data
		var ptr = Module._malloc(numBytes);
		// get a bytes-wise view on the newly allocated buffer
		var heapBytes= new Uint8Array(Module.HEAPU8.buffer, ptr, numBytes);
		// copy data into heapBytes
		heapBytes.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));// issue #11 (2): do use byteOffset and byteLength for copying the data in case the underlying buffer/ArrayBuffer of the TypedArray view is larger than the TypedArray
		var status = Module.ccall('FLAC__stream_encoder_process_interleaved', 'number',
				['number', 'number', 'number'],
				[encoder, heapBytes.byteOffset, num_of_samples]
		);
		Module._free(ptr);
		return status;
	},

	/**
	 * Encode / submit data for encoding.
	 *
	 * Submit data for encoding. This version allows you to supply the input data via an array of pointers,
	 * each pointer pointing to an array of samples samples representing one channel.
	 * The samples need not be block-aligned, but each channel should have the same number of samples.
	 *
	 * Each sample should be a signed integer, right-justified to the resolution set by FLAC__stream_encoder_set_bits_per_sample().
	 * For example, if the resolution is 16 bits per sample, the samples should all be in the range [-32768,32767].
	 *
	 *
	 * For applications where channel order is important, channels must follow the order as described in the frame header.
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @param {TypedArray[]} channelBuffers
	 * 				an array for the audio data channels as typed arrays with signed integers (and size according to the set bits-per-sample setting)
	 *
	 * @param {number} num_of_samples
	 * 				the number of samples in one channel (i.e. one of the buffers)
	 *
	 * @returns {boolean} true if successful, else false; in this case, check the encoder state with FLAC__stream_encoder_get_state() to see what went wrong.
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_encoder_process: function(encoder, channelBuffers, num_of_samples){

		var ptrInfo = this._create_pointer_array(channelBuffers);
		var pointerPtr = ptrInfo.pointerPointer;

		var status = Module.ccall('FLAC__stream_encoder_process', 'number',
				['number', 'number', 'number'],
				[encoder, pointerPtr, num_of_samples]
		);

		this._destroy_pointer_array(ptrInfo);
		return status;
	},
	/**
	 * Decodes a single frame.
	 *
	 * To check decoding progress, use {@link #FLAC__stream_decoder_get_state}.
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @returns {boolean} FALSE if an error occurred
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_decoder_process_single: Module.cwrap('FLAC__stream_decoder_process_single', 'number', ['number']),

	/**
	 * Decodes data until end of stream.
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @returns {boolean} FALSE if an error occurred
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_decoder_process_until_end_of_stream: Module.cwrap('FLAC__stream_decoder_process_until_end_of_stream', 'number', ['number']),

	/**
	 * Decodes data until end of metadata.
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @returns {boolean} false if any fatal read, write, or memory allocation error occurred (meaning decoding must stop), else true.
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_decoder_process_until_end_of_metadata: Module.cwrap('FLAC__stream_decoder_process_until_end_of_metadata', 'number', ['number']),

	/**
	 * Decoder state code.
	 *
	 * @interface FLAC__StreamDecoderState
	 * @memberOf Flac
	 *
	 * @property {"FLAC__STREAM_DECODER_SEARCH_FOR_METADATA"} 		0	The decoder is ready to search for metadata
	 * @property {"FLAC__STREAM_DECODER_READ_METADATA"}  			1	The decoder is ready to or is in the process of reading metadata
	 * @property {"FLAC__STREAM_DECODER_SEARCH_FOR_FRAME_SYNC"} 	2	The decoder is ready to or is in the process of searching for the frame sync code
	 * @property {"FLAC__STREAM_DECODER_READ_FRAME"}				3	The decoder is ready to or is in the process of reading a frame
	 * @property {"FLAC__STREAM_DECODER_END_OF_STREAM"}				4	The decoder has reached the end of the stream
	 * @property {"FLAC__STREAM_DECODER_OGG_ERROR"}					5	An error occurred in the underlying Ogg layer
	 * @property {"FLAC__STREAM_DECODER_SEEK_ERROR"}				6	An error occurred while seeking. The decoder must be flushed with FLAC__stream_decoder_flush() or reset with FLAC__stream_decoder_reset() before decoding can continue
	 * @property {"FLAC__STREAM_DECODER_ABORTED"}					7	The decoder was aborted by the read callback
	 * @property {"FLAC__STREAM_DECODER_MEMORY_ALLOCATION_ERROR"}	8	An error occurred allocating memory. The decoder is in an invalid state and can no longer be used
	 * @property {"FLAC__STREAM_DECODER_UNINITIALIZED"}				9	The decoder is in the uninitialized state; one of the FLAC__stream_decoder_init_*() functions must be called before samples can be processed.
	 *
	 */
	/**
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @returns {Flac.FLAC__StreamDecoderState} the decoder state
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_decoder_get_state: Module.cwrap('FLAC__stream_decoder_get_state', 'number', ['number']),

	/**
	 * Encoder state code.
	 *
	 * @interface FLAC__StreamEncoderState
	 * @memberOf Flac
	 *
	 * @property {"FLAC__STREAM_ENCODER_OK"}								0 	The encoder is in the normal OK state and samples can be processed.
	 * @property {"FLAC__STREAM_ENCODER_UNINITIALIZED"}						1 	The encoder is in the uninitialized state; one of the FLAC__stream_encoder_init_*() functions must be called before samples can be processed.
	 * @property {"FLAC__STREAM_ENCODER_OGG_ERROR"}							2 	An error occurred in the underlying Ogg layer.
	 * @property {"FLAC__STREAM_ENCODER_VERIFY_DECODER_ERROR"}				3 	An error occurred in the underlying verify stream decoder; check FLAC__stream_encoder_get_verify_decoder_state().
	 * @property {"FLAC__STREAM_ENCODER_VERIFY_MISMATCH_IN_AUDIO_DATA"}		4 	The verify decoder detected a mismatch between the original audio signal and the decoded audio signal.
	 * @property {"FLAC__STREAM_ENCODER_CLIENT_ERROR"}						5 	One of the callbacks returned a fatal error.
	 * @property {"FLAC__STREAM_ENCODER_IO_ERROR"}							6 	An I/O error occurred while opening/reading/writing a file. Check errno.
	 * @property {"FLAC__STREAM_ENCODER_FRAMING_ERROR"}						7 	An error occurred while writing the stream; usually, the write_callback returned an error.
	 * @property {"FLAC__STREAM_ENCODER_MEMORY_ALLOCATION_ERROR"}			8 	Memory allocation failed.
	 *
	 */
	/**
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @returns {Flac.FLAC__StreamEncoderState} the encoder state
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_encoder_get_state:  Module.cwrap('FLAC__stream_encoder_get_state', 'number', ['number']),
	/**
	 * Direct the decoder to pass on all metadata blocks of type type.
	 *
	 * By default, only the STREAMINFO block is returned via the metadata callback.
	 *
	 * <p>
	 * NOTE: only use on un-initilized decoder instances!
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @param {Flac.FLAC__MetadataType} type  the metadata type to be enabled
	 *
	 * @returns {boolean} <code>false</code> if the decoder is already initialized, else <code>true</code>
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see Flac#FLAC__stream_decoder_set_metadata_respond_all
	 */
	FLAC__stream_decoder_set_metadata_respond: Module.cwrap('FLAC__stream_decoder_set_metadata_respond', 'number', ['number', 'number']),
	/**
	 * Direct the decoder to pass on all APPLICATION metadata blocks of the given id.
	 *
	 * By default, only the STREAMINFO block is returned via the metadata callback.
	 *
	 * <p>
	 * NOTE: only use on un-initilized decoder instances!
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @param {number} id  the ID of application metadata
	 *
	 * @returns {boolean} <code>false</code> if the decoder is already initialized, else <code>true</code>
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see Flac#FLAC__stream_decoder_set_metadata_respond_all
	 */
	FLAC__stream_decoder_set_metadata_respond_application: Module.cwrap('FLAC__stream_decoder_set_metadata_respond_application', 'number', ['number', 'number']),// (FLAC__StreamDecoder *decoder, const FLAC__byte id[4])
	/**
	 * Direct the decoder to pass on all metadata blocks of any type.
	 *
	 * By default, only the STREAMINFO block is returned via the metadata callback.
	 *
	 * <p>
	 * NOTE: only use on un-initilized decoder instances!
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @returns {boolean} <code>false</code> if the decoder is already initialized, else <code>true</code>
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see Flac#FLAC__stream_decoder_set_metadata_ignore_all
	 * @see Flac#FLAC__stream_decoder_set_metadata_respond_application
	 * @see Flac#FLAC__stream_decoder_set_metadata_respond
	 */
	FLAC__stream_decoder_set_metadata_respond_all: Module.cwrap('FLAC__stream_decoder_set_metadata_respond_all', 'number', ['number']),// (FLAC__StreamDecoder *decoder)
	/**
	 * Direct the decoder to filter out all metadata blocks of type type.
	 *
	 * By default, only the STREAMINFO block is returned via the metadata callback.
	 *
	 * <p>
	 * NOTE: only use on un-initilized decoder instances!
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @param {Flac.FLAC__MetadataType} type  the metadata type to be ignored
	 *
	 * @returns {boolean} <code>false</code> if the decoder is already initialized, else <code>true</code>
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see Flac#FLAC__stream_decoder_set_metadata_ignore_all
	 */
	FLAC__stream_decoder_set_metadata_ignore: Module.cwrap('FLAC__stream_decoder_set_metadata_ignore', 'number', ['number', 'number']),// (FLAC__StreamDecoder *decoder, FLAC__MetadataType type)
	/**
	 * Direct the decoder to filter out all APPLICATION metadata blocks of the given id.
	 *
	 * By default, only the STREAMINFO block is returned via the metadata callback.
	 *
	 * <p>
	 * NOTE: only use on un-initilized decoder instances!
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @param {number} id  the ID of application metadata
	 *
	 * @returns {boolean} <code>false</code> if the decoder is already initialized, else <code>true</code>
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see Flac#FLAC__stream_decoder_set_metadata_ignore_all
	 */
	FLAC__stream_decoder_set_metadata_ignore_application: Module.cwrap('FLAC__stream_decoder_set_metadata_ignore_application', 'number', ['number', 'number']),// (FLAC__StreamDecoder *decoder, const FLAC__byte id[4])
	/**
	 * Direct the decoder to filter out all metadata blocks of any type.
	 *
	 * By default, only the STREAMINFO block is returned via the metadata callback.
	 *
	 * <p>
	 * NOTE: only use on un-initilized decoder instances!
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @returns {boolean} <code>false</code> if the decoder is already initialized, else <code>true</code>
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see Flac#FLAC__stream_decoder_set_metadata_respond_all
	 * @see Flac#FLAC__stream_decoder_set_metadata_ignore
	 * @see Flac#FLAC__stream_decoder_set_metadata_ignore_application
	 */
	FLAC__stream_decoder_set_metadata_ignore_all: Module.cwrap('FLAC__stream_decoder_set_metadata_ignore_all', 'number', ['number']),// (FLAC__StreamDecoder *decoder)
	/**
	 * Set the metadata blocks to be emitted to the stream before encoding. A value of NULL, 0 implies no metadata; otherwise, supply an array of pointers to metadata blocks.
	 * The array is non-const since the encoder may need to change the is_last flag inside them, and in some cases update seek point offsets. Otherwise, the encoder
	 * will not modify or free the blocks. It is up to the caller to free the metadata blocks after encoding finishes.
	 *
	 * <p>
	 *     The encoder stores only copies of the pointers in the metadata array; the metadata blocks themselves must survive at least until after FLAC__stream_encoder_finish() returns.
	 *     Do not free the blocks until then.
	 *
	 *     The STREAMINFO block is always written and no STREAMINFO block may occur in the supplied array.
	 *
	 *     By default the encoder does not create a SEEKTABLE. If one is supplied in the metadata array, but the client has specified that it does not support seeking,
	 *     then the SEEKTABLE will be written verbatim. However by itself this is not very useful as the client will not know the stream offsets for the seekpoints ahead of time.
	 *     In order to get a proper seektable the client must support seeking. See next note.
	 *
	 *     SEEKTABLE blocks are handled specially. Since you will not know the values for the seek point stream offsets, you should pass in a SEEKTABLE 'template', that is,
	 *     a SEEKTABLE object with the required sample numbers (or placeholder points), with 0 for the frame_samples and stream_offset fields for each point.
	 *     If the client has specified that it supports seeking by providing a seek callback to FLAC__stream_encoder_init_stream() or both seek AND read callback to
	 *      FLAC__stream_encoder_init_ogg_stream() (or by using FLAC__stream_encoder_init*_file() or FLAC__stream_encoder_init*_FILE()), then while it is encoding the encoder will
	 *      fill the stream offsets in for you and when encoding is finished, it will seek back and write the real values into the SEEKTABLE block in the stream. There are helper
	 *      routines for manipulating seektable template blocks; see metadata.h: FLAC__metadata_object_seektable_template_*(). If the client does not support seeking,
	 *      the SEEKTABLE will have inaccurate offsets which will slow down or remove the ability to seek in the FLAC stream.
	 *
	 *     The encoder instance will modify the first SEEKTABLE block as it transforms the template to a valid seektable while encoding, but it is still up to the caller to free
	 *     all metadata blocks after encoding.
	 *
	 *     A VORBIS_COMMENT block may be supplied. The vendor string in it will be ignored. libFLAC will use it's own vendor string. libFLAC will not modify the passed-in
	 *     VORBIS_COMMENT's vendor string, it will simply write it's own into the stream. If no VORBIS_COMMENT block is present in the metadata array, libFLAC will write an
	 *     empty one, containing only the vendor string.
	 *
	 *     The Ogg FLAC mapping requires that the VORBIS_COMMENT block be the second metadata block of the stream. The encoder already supplies the STREAMINFO block automatically.
	 *
	 *     If metadata does not contain a VORBIS_COMMENT block, the encoder will supply that too. Otherwise, if metadata does contain a VORBIS_COMMENT block and it is not the first,
	 *     the init function will reorder metadata by moving the VORBIS_COMMENT block to the front; the relative ordering of the other blocks will remain as they were.
	 *
	 *     The Ogg FLAC mapping limits the number of metadata blocks per stream to 65535. If num_blocks exceeds this the function will return false.
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @param {Flac.PointerInfo} metadataBuffersPointer
	 *
	 * @param {number} num_blocks
	 *
	 * @returns {boolean} <code>false</code> if the encoder is already initialized, else <code>true</code>. <code>false</code> if the encoder is already initialized, or if num_blocks > 65535 if encoding to Ogg FLAC, else true.
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see Flac.FLAC__MetadataType
	 * @see Flac#_create_pointer_array
	 * @see Flac#_destroy_pointer_array
	 */
	FLAC__stream_encoder_set_metadata: function(encoder, metadataBuffersPointer, num_blocks){// ( FLAC__StreamEncoder *  encoder, FLAC__StreamMetadata **  metadata, unsigned  num_blocks)
		var status = Module.ccall('FLAC__stream_encoder_set_metadata', 'number',
				['number', 'number', 'number'],
				[encoder, metadataBuffersPointer.pointerPointer, num_blocks]
		);
		return status;
	},
	/**
	 * Helper object for allocating an array of buffers on the (memory) heap.
	 *
	 * @interface PointerInfo
	 * @memberOf Flac
	 * @property {number}  pointerPointer pointer to the array of (pointer) buffers
	 * @property {number[]}  dataPointer array of pointers to the allocated data arrays (i.e. buffers)
	 *
	 * @see Flac#_create_pointer_array
	 * @see Flac#_destroy_pointer_array
	 */
	/**
	 * Helper function for creating pointer (and allocating the data) to an array of buffers on the (memory) heap.
	 *
	 * Use the returned <code>PointerInfo.dataPointer</code> as argument, where the array-pointer is required.
	 *
	 * NOTE: afer use, the allocated buffers on the heap need be freed, see {@link #_destroy_pointer_array}.
	 *
	 * @param {Uint8Array[]} bufferArray
	 * 						the buffer for which to create
	 *
	 * @returns {Flac.PointerInfo} <code>false</code> if the decoder is already initialized, else <code>true</code>
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see Flac#_destroy_pointer_array
	 */
	_create_pointer_array: function(bufferArray){
		var size=bufferArray.length;
		var ptrs = [], ptrData = new Uint32Array(size);
		var ptrOffsets = new DataView(ptrData.buffer);
		var buffer, numBytes, heapBytes, ptr;
		for(var i=0, size; i < size; ++i){
			buffer = bufferArray[i];
			// get the length of the data in bytes
			numBytes = buffer.length * buffer.BYTES_PER_ELEMENT;
			// malloc enough space for the data
			ptr = Module._malloc(numBytes);
			ptrs.push(ptr);
			// get a bytes-wise view on the newly allocated buffer
			heapBytes = new Uint8Array(Module.HEAPU8.buffer, ptr, numBytes);
			// copy data into heapBytes
			heapBytes.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));// use FIX for issue #11 (2)
			ptrOffsets.setUint32(i*4, ptr, true);
		}
		var nPointerBytes = ptrData.length * ptrData.BYTES_PER_ELEMENT
		var pointerPtr = Module._malloc(nPointerBytes);
		var pointerHeap = new Uint8Array(Module.HEAPU8.buffer, pointerPtr, nPointerBytes);
		pointerHeap.set( new Uint8Array(ptrData.buffer) );

		return {
			dataPointer: ptrs,
			pointerPointer: pointerPtr
		};
	},
	/**
	 * Helper function for destroying/freeing a previously created pointer (and allocating the data) of an array of buffers on the (memory) heap.
	 *
	 * @param {Flac.PointerInfo} pointerInfo
	 * 						the pointer / allocation information that should be destroyed/freed
	 *
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see Flac#_create_pointer_array
	 */
	_destroy_pointer_array: function(pointerInfo){
		var pointerArray = pointerInfo.dataPointer;
		for(var i=0, size=pointerArray.length; i < size; ++i){
			Module._free(pointerArray[i]);
		}
		Module._free(pointerInfo.pointerPointer);
	},
	/**
	 * Get if MD5 verification is enabled for the decoder
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @returns {boolean} <code>true</code> if MD5 verification is enabled
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see #FLAC__stream_decoder_set_md5_checking
	 */
	FLAC__stream_decoder_get_md5_checking: Module.cwrap('FLAC__stream_decoder_get_md5_checking', 'number', ['number']),

	/**
	 * Set the "MD5 signature checking" flag. If true, the decoder will compute the MD5 signature of the unencoded audio data while decoding and compare it to the signature from the STREAMINFO block,
	 * if it exists, during {@link Flac.FLAC__stream_decoder_finish FLAC__stream_decoder_finish()}.
	 *
	 * MD5 signature checking will be turned off (until the next {@link Flac.FLAC__stream_decoder_reset FLAC__stream_decoder_reset()}) if there is no signature in the STREAMINFO block or when a seek is attempted.
	 *
	 * Clients that do not use the MD5 check should leave this off to speed up decoding.
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 * @param {boolean} is_verify
	 * 				enable/disable checksum verification during decoding
	 * @returns {boolean} FALSE if the decoder is already initialized, else TRUE.
	 *
	 * @memberOf Flac#
	 * @function
	 *
	 * @see #FLAC__stream_decoder_get_md5_checking
	 */
	FLAC__stream_decoder_set_md5_checking: function(decoder, is_verify){
		is_verify = is_verify? 1 : 0;
		return Module.ccall('FLAC__stream_decoder_set_md5_checking', 'number', ['number', 'number'], [ decoder, is_verify ]);
	},

	/**
	 * Finish the encoding process.
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @returns {boolean} <code>false</code> if an error occurred processing the last frame;
	 * 					 or if verify mode is set, there was a verify mismatch; else <code>true</code>.
	 * 					 If <code>false</code>, caller should check the state with {@link Flac#FLAC__stream_encoder_get_state}
	 * 					 for more information about the error.
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_encoder_finish: Module.cwrap('FLAC__stream_encoder_finish', 'number', [ 'number' ]),
	/**
	 * Finish the decoding process.
	 *
	 * The decoder can be reused, after initializing it again.
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @returns {boolean} <code>false</code> if MD5 checking is on AND a STREAMINFO block was available AND the MD5 signature in
	 * 						 the STREAMINFO block was non-zero AND the signature does not match the one computed by the decoder;
	 * 						 else <code>true</code>.
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_decoder_finish: Module.cwrap('FLAC__stream_decoder_finish', 'number', [ 'number' ]),
	/**
	 * Reset the decoder for reuse.
	 *
	 * <p>
	 * NOTE: Needs to be re-initialized, before it can be used again
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @returns {boolean} true if successful
	 *
	 * @see #init_decoder_stream
	 * @see #init_decoder_ogg_stream
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_decoder_reset: Module.cwrap('FLAC__stream_decoder_reset', 'number', [ 'number' ]),
	/**
	 * Delete the encoder instance, and free up its resources.
	 *
	 * @param {number} encoder
	 * 				the ID of the encoder instance
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_encoder_delete: function(encoder){
		this._clear_enc_cb(encoder);//<- remove callback references
		Module.ccall('FLAC__stream_encoder_delete', 'number', [ 'number' ], [encoder]);
		do_fire_event('destroyed', [{type: 'destroyed', target: {id: encoder, type: 'encoder'}}], false);
	},
	/**
	 * Delete the decoder instance, and free up its resources.
	 *
	 * @param {number} decoder
	 * 				the ID of the decoder instance
	 *
	 * @memberOf Flac#
	 * @function
	 */
	FLAC__stream_decoder_delete: function(decoder){
		this._clear_dec_cb(decoder);//<- remove callback references
		Module.ccall('FLAC__stream_decoder_delete', 'number', [ 'number' ], [decoder]);
		do_fire_event('destroyed', [{type: 'destroyed', target: {id: decoder, type: 'decoder'}}], false);
	}

};//END: var _exported = {

export const {
  setOptions, getOptions, isReady, on, off, FLAC__stream_encoder_set_verify,
  FLAC__stream_encoder_set_compression_level, FLAC__stream_encoder_set_blocksize,
  FLAC__stream_encoder_get_verify_decoder_state, FLAC__stream_encoder_get_verify,
  create_libflac_encoder, init_libflac_encoder, create_libflac_decoder,
  init_libflac_decoder, init_encoder_stream, init_encoder_ogg_stream,
  init_decoder_stream, init_decoder_ogg_stream, FLAC__stream_encoder_process_interleaved,
  FLAC__stream_encoder_process, FLAC__stream_decoder_process_single,
  FLAC__stream_decoder_process_until_end_of_stream,
  FLAC__stream_decoder_process_until_end_of_metadata,
  FLAC__stream_decoder_get_state, FLAC__stream_encoder_get_state,
  FLAC__stream_decoder_set_metadata_respond,
  FLAC__stream_decoder_set_metadata_respond_application,
  FLAC__stream_decoder_set_metadata_respond_all,
  FLAC__stream_decoder_set_metadata_ignore,
  FLAC__stream_decoder_set_metadata_ignore_application,
  FLAC__stream_decoder_set_metadata_ignore_all,
  FLAC__stream_encoder_set_metadata,
  _create_pointer_array, _destroy_pointer_array,
  FLAC__stream_decoder_get_md5_checking, FLAC__stream_decoder_set_md5_checking,
  FLAC__stream_encoder_finish, FLAC__stream_decoder_finish,
  FLAC__stream_decoder_reset, FLAC__stream_encoder_delete,
  FLAC__stream_decoder_delete,
} = _exported;
