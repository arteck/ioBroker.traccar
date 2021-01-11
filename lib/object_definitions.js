const object_definitions = {
    'devices': {
        type: 'channel',
        common: {
            name: 'Devices'
        },
        native: {}
    },
    'devices.device': {
        type: 'channel',
        common: {
            name: 'Device'
        },
        native: {}
    },
    'devices.device.altitude': {
        type: 'state',
        common: {
            'name': 'Altitude',
            'role': 'value.distance',
            'type': 'number',
            'unit': 'm',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.battery_level': {
        type: 'state',
        common: {
            'name': 'Battery level',
            'role': 'value.battery',
            'type': 'number',
            'unit': '%',
            'write': false,
            'read': true
        },
        native: {}
    },

    'devices.device.course': {
        type: 'state',
        common: {
            'name': 'Course',
            'role': 'state',
            'type': 'number',
            'unit': '°',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.device_name': {
        type: 'state',
        common: {
            'name': 'Device name',
            'role': 'info.name',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.distance': {
        type: 'state',
        common: {
            'name': 'Distance',
            'role': 'value.distance',
            'type': 'number',
            'unit': 'm',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.geofence_ids': {
        type: 'state',
        common: {
            'name': 'Geofence IDs',
            'role': 'json',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.geofences': {
        type: 'state',
        common: {
            'name': 'Geofences',
            'role': 'json',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.geofences_string': {
        type: 'state',
        common: {
            'name': 'Geofences as string',
            'role': 'text',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.last_update': {
        type: 'state',
        common: {
            'name': 'Last update',
            'role': 'date',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.latitude': {
        type: 'state',
        common: {
            'name': 'Latitude',
            'role': 'value.gps.latitude',
            'type': 'number',
            'unit': '°',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.longitude': {
        type: 'state',
        common: {
            'name': 'Longitude',
            'role': 'value.gps.longitude',
            'unit': '°',
            'type': 'number',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.motion': {
        type: 'state',
        common: {
            'name': 'Motion',
            'role': 'sensor.motion',
            'type': 'boolean',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.position': {
        type: 'state',
        common: {
            'name': 'Position',
            'role': 'value.gps',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.position_url': {
        type: 'state',
        common: {
            'name': 'Position URL',
            'role': 'text.url',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.address': {
        type: 'state',
        common: {
            'name': 'Address',
            'role': 'location',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.speed': {
        type: 'state',
        common: {
            'name': 'Speed',
            'role': 'value.speed',
            'type': 'number',
            'unit': 'km/h',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.status': {
        type: 'state',
        common: {
            'name': 'Status',
            'role': 'state',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.total_distance': {
        type: 'state',
        common: {
            'name': 'Total distance',
            'role': 'value.distance',
            'type': 'number',
            'unit': 'm',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.unique_id': {
        type: 'state',
        common: {
            'name': 'Unique ID',
            'role': 'state',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'geofences': {
        type: 'channel',
        common: {
            name: 'Geofences'
        },
        native: {}
    },
    'geofences.geofence': {
        type: 'channel',
        common: {
            name: 'Geofence'
        },
        native: {}
    },
    'geofences.geofence.geofence_name': {
        type: 'state',
        common: {
            'name': 'Geofence name',
            'role': 'info.name',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'geofences.geofence.device_ids': {
        type: 'state',
        common: {
            'name': 'Device IDs',
            'role': 'json',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'geofences.geofence.devices': {
        type: 'state',
        common: {
            'name': 'Devices',
            'role': 'json',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'geofences.geofence.devices_string': {
        type: 'state',
        common: {
            'name': 'Devices as string',
            'role': 'text',
            'type': 'string',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.ignition': {
        type: 'state',
        common: {
            'name': 'Ignition',
            'role': 'state',
            'type': 'boolean',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.throttle': {
        type: 'state',
        common: {
            'name': 'Throttle',
            'role': 'state',
            'type': 'number',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.fuel': {
        type: 'state',
        common: {
            'name': 'Fuel',
            'role': 'state',
            'type': 'number',
            'unit': 'l',
            'write': false,
            'read': true
        },
        native: {}
    },
    'devices.device.odometer': {
        type: 'state',
        common: {
            'name': 'Odometer',
            'role': 'state',
            'type': 'number',
            'unit': 'km',
            'write': false,
            'read': true
        },
        native: {}
    }
};

module.exports = { defObj: object_definitions };