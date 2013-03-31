var xbee = require('xbee2');

var myXbee = xbee.openPort('/dev/tty.usbserial-A601EKIJ', {'baudrate': 9600});

myXbee.on('data', function(data) {
	console.log('Data received:', data);
});

myXbee.on('open', function() {
	console.log('Xbee is now open');
	
	myXbee.ATCommand('CH');
	myXbee.ATCommand('ID');
	myXbee.ATCommand('MY');
	myXbee.TransmitData('0013A20040A6299D', 'FFFE', 'Hello World');
});