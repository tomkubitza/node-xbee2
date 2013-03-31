var SerialPort = require('serialport').SerialPort,
	Buffer = require('buffer').Buffer,
	sys = require('sys');

function getAddressFromBytes(bytes) {
	var address = { 'raw': bytes, 'hex': '', 'dec': 0 };

	for(var i = 0; i < bytes.length; i ++) {
		if(bytes[i] < 16) address.hex += '0';
		address.hex += Number(bytes[i]).toString(16);
		address.dec += address << (56 - i*8);
	}

	return address;
}

function getBytesFromAddress(address, size) {
	var bytes = [];
	if(typeof address === 'object') {
		if(address.length == size)
			bytes = address;
		else if(address.raw)
			return getBytesFromAddress(address.raw, size);
		else if(address.hex)
			return getBytesFromAddress(address.hex, size);
		else if(address.dec)
			return getBytesFromAddress(address.dec, size);
	}else{
		var number = (typeof address === 'number') ? address : parseInt(address, 16);
		if(typeof number === 'number')
			for(var i = 0; i < size; i ++) {
				bytes.push(number % 256);
				number = Math.floor(number / 256);
			}
		bytes.reverse();
	}
	while(bytes.length < size)
		bytes.push(0x00);
	return bytes;
}

var commandStatus = ['OK', 'ERROR', 'Invalid Command', 'Invalid Parameter', 'Tx Failure'];
var modemStatus = {
	0: 'Hardware reset',
	1: 'Watchdog timer reset',
	2: 'Joined network',
	3: 'Disassociated',
	6: 'Coordinator started',
	7: 'Network security key was updated',
	13: 'Voltage supply limit exceeded',
	17: 'Modem configuration changed while join in progress',
	128: 'Stack error'
};
var deliveryStatus = {
	0: 'Success',
	1: 'MAC ACK Failure',
	2: 'CCA Failure',
	21: 'Invalid destination endpoint',
	33: 'Network ACK Failure',
	34: 'Not Joined to Network',
	35: 'Self-addressed',
	36: 'Address Not Found',
	37: 'Route Not Found',
	38: 'Broadcast source failed to hear a neighbor relay the message',
	43: 'Invalid binding table index',
	44: 'Resource error lack of free buffers, timers, etc.',
	45: 'Attempted broadcast with APS transmission',
	46: 'Attempted unicast with APS transmission, but EE=0',
	50: 'Resource error lack of free buffers, timers, etc.',
	116: 'Data payload too large',
	117: 'Indirect message unrequested',
};
var discoveryStatus = {
	0: 'No Discovery Overhead',
	1: 'Address Discovery',
	2: 'Route Discovery',
	3: 'Address and Route Discovery',
	64: 'Extended Timeout Discovery'
};

function formatPacket(packet) {
	switch(packet[0]) {
		case 0x88:
			return {
				'type': 'AT Command',
				'frameId': packet[1],
				'command': String.fromCharCode(packet[2], packet[3]),
				'status': {'code': packet[4], 'name': commandStatus[packet[4]]},
				'data': packet.slice(5)
			};
		case 0x8A: {
			var result = {
				'type': 'Modem Status',
				'status': {'code': packet[1], 'name': modemStatus[packet[1]]}
			};
			if(result.status.code >= 128)
				result.status.name = modemStatus[128];
			return result;
		} case 0x8B:
			return {
				'type': 'Transmit Data',
				'frameId': packet[1],
				'address': {
					'16': getAddressFromBytes(packet.slice(2, 4))
				},
				'retryCount': packet[4],
				'deliveryStatus': {'code': packet[5], 'name': deliveryStatus[packet[5]]},
				'discoveryStatus': {'code': packet[6], 'name': discoveryStatus[packet[6]]}
			};
		case 0x90: {
			var result = {
				'type': 'Received Data',
				'address': {
					'64': getAddressFromBytes(packet.slice(1, 9)),
					'16': getAddressFromBytes(packet.slice(9, 11))
				},
				'options': packet[11],
				'data': {'raw': packet.slice(12), 'string': ''}
			};
			for(var i = 0; i < result.data.raw.length; i ++)
				result.data.string += String.fromCharCode(result.data.raw[i]);
			return result;
		} case 0x92: {
			var result = {
				'type': 'Received IO Sample',
				'address': {
					'64': getAddressFromBytes(packet.slice(1, 9)),
					'16': getAddressFromBytes(packet.slice(9, 11))
				},
				'options': packet[11],
				'sampleCount': packet[12],
				'digitalValues': [],
				'analogValues': []
			};
			var analogIndex = 15;
			for(var i = 0; i < 8; i ++) {
				var searchBitMask = 0x01 << i;
				if(packet[12] & searchBitMask) {
					result.digitalValues[i+8] = packet[15] & searchBitMask;
					analogIndex = 17;
				}
				if(packet[13] & searchBitMask) {
					result.digitalValues[i] = packet[16] & searchBitMask;
					analogIndex = 17;
				}
				if(packet[14] & searchBitMask)
					result.analogValues[i] = true;
			}
			for(var i in result.analogValues)
				result.analogValues[i] = (packet[analogIndex ++] << 8) + packet[analogIndex ++];
			return result;
		} case 0x97:
			return {
				'type': 'Remote AT Command',
				'frameId': packet[1],
				'address': {
					'64': getAddressFromBytes(packet.slice(2, 10)),
					'16': getAddressFromBytes(packet.slice(10, 12))
				},
				'command': String.fromCharCode(packet[12]) + String.fromCharCode(packet[13]),
				'status': {'code': packet[14], 'name': commandStatus[packet[14]]},
				'data': packet.slice(15)
			};
		default:
			return packet;
	}
}

exports.openPort = function(url, options) {
	var packet = null;

	options['parser'] = function(emitter, buffer) {
		for(var i = 0; i < buffer.length; i ++) {
		 	//Waiting for start byte
		 	if(packet == null) {
		 		if(buffer[i] != 0x7E) continue;
		 		packet = [];
		 	}
	
		 	packet.push(buffer[i]);
	
		 	//Waiting for length
		 	if(packet.length < 3)
		 		continue;
	
		 	//Waiting for content
		 	var length = (packet[1] << 8) + packet[2];
		 	if(packet.length - 4 < length)
		 		continue;
	
		 	//Calculate checksum
		 	var checksum = 0;
				for(var j = 3; j < packet.length - 1; j ++)
					checksum += packet[j];
			checksum = (checksum % 256) + packet[packet.length - 1];
	
			//Emit packet if checksum is correct
			if(checksum == 0xFF)
		 		emitter.emit("data", formatPacket(packet.slice(3, -1)));
	
		 	packet = null;
		}
	};

	var port = new SerialPort(url, options);

	port.frameId = 0;
	port.SendPacket = function(type, content) {
		var data = [0x7E], length = content.length + 2;
		data.push(length >> 8);
		data.push(length % 256);
		data.push(type);
		
		this.frameId ++;
		if(this.frameId >= 256) this.frameId = 1;
		data.push(this.frameId);
		data = data.concat(content);
	
		var checksum = 0;
		for(var i = 3; i < data.length; i ++)
			checksum += data[i];
		data.push(255 - (checksum % 256));
	
		this.write(data);
	}

	port.AT = function(command, parameters) {
		var content = [command.charCodeAt(0), command.charCodeAt(1)];
		
		if(parameters)
			content = content.concat(parameters);
		
		this.SendPacket(0x08, content);
	};

	port.TransmitData = function(destination64, destination16, data, options, radius) {
		var content = getBytesFromAddress(destination64, 8).concat(getBytesFromAddress(destination16, 2));
	
		content.push((radius == null) ? 0x00 : radius);
		content.push((options == null) ? 0x00 : options);

		if(typeof data === 'string') {
			var dataBytes = [];
			for(var i = 0; i < data.length; i ++)
				dataBytes.push(data.charCodeAt(i));
			content = content.concat(dataBytes);
		}else
			content = content.concat(data);

		this.SendPacket(0x10, content);
	};

	port.RemoteAT = function(destination64, destination16, command, parameters, options) {
		var content = getBytesFromAddress(destination64, 8).concat(getBytesFromAddress(destination16, 2));
	
		content.push((options == null) ? 0x02 : options);
		content.push(command.charCodeAt(0));
		content.push(command.charCodeAt(1));
	
		if(parameters)
			content = content.concat(parameters);
		
		this.SendPacket(0x17, content);
	};

	port.CreateSourceRoute = function(destination64, destination16, route) {
		var content = getBytesFromAddress(destination64, 8).concat(getBytesFromAddress(destination16, 2));

		content.push(0x00); //Reserved for options
		content.push(route.length);

		for(var i = 0; i < route.length; i ++)
			content.push(getBytesFromAddress(route[i], 2));
	
		this.SendPacket(0x21, content);
	};

	return port;
};