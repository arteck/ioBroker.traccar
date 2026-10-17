'use strict';

/**
 * Compares numeric dotted version strings.
 *
 * @param {string} a Candidate version.
 * @param {string} b Installed version.
 * @returns {boolean} Whether a is newer than b.
 */
function isVersionNewer(a, b) {
    if (!/^\d+(?:\.\d+)*$/.test(a) || !/^\d+(?:\.\d+)*$/.test(b)) {
        return false;
    }
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    const maxLen = Math.max(aParts.length, bParts.length);

    for (let i = 0; i < maxLen; i++) {
        const aNum = aParts[i] || 0;
        const bNum = bParts[i] || 0;
        if (aNum !== bNum) {
            return aNum > bNum;
        }
    }
    return false;
}

/**
 * Resolves geofence IDs to names, leaving unknown IDs as null.
 *
 * @param {number[]} geofenceIds IDs to resolve.
 * @param {object[]} geofences Known geofences.
 * @returns {(string|null)[]} Resolved names.
 */
function resolveGeofenceNames(geofenceIds, geofences) {
    return geofenceIds.map((id) => geofences.find((geofence) => String(geofence.id) === String(id))?.name ?? null);
}

/**
 * Retries geofence lookup once before returning explicit labels for unknown IDs.
 *
 * @param {number[]} geofenceIds IDs to resolve.
 * @param {object[]} geofences Current geofence list.
 * @param {() => Promise<object[]>} reload Reloads and returns geofences.
 * @param {(id: number) => void} onUnknown Called for unresolved IDs.
 * @returns {Promise<string[]>} Resolved geofence names.
 */
async function resolveGeofenceNamesWithRetry(geofenceIds, geofences, reload, onUnknown) {
    let names = resolveGeofenceNames(geofenceIds, geofences);
    if (names.some((name) => name === null)) {
        names = resolveGeofenceNames(geofenceIds, await reload());
    }
    return names.map((name, index) => {
        if (name !== null) {
            return name;
        }
        onUnknown(geofenceIds[index]);
        return `Unknown geofence (${geofenceIds[index]})`;
    });
}

/**
 * Returns the devices currently inside a geofence.
 *
 * @param {object} geofence Target geofence.
 * @param {boolean} serverVersion58 Whether positions provide geofence IDs.
 * @param {object[]} devices Known devices.
 * @param {Map<string, Set<string>>} geofencesNow Cached position geofences.
 * @returns {[number[], string[]]} Device IDs and names.
 */
function getGeoDeviceState(geofence, serverVersion58, devices, geofencesNow) {
    const deviceIds = [];
    const deviceNames = [];
    const geofenceId = String(geofence.id);

    for (const device of devices) {
        const isInside = serverVersion58
            ? geofencesNow.get(String(device.id))?.has(geofenceId)
            : Array.isArray(device.geofenceIds) && device.geofenceIds.some((id) => String(id) === geofenceId);
        if (isInside) {
            deviceIds.push(device.id);
            deviceNames.push(device.name);
        }
    }
    return [deviceIds, deviceNames];
}

/**
 * Converts a value to a finite number, or null when it is missing or invalid.
 *
 * @param {unknown} value Input value.
 * @returns {number|null} Parsed value.
 */
function parseFiniteNumber(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * Checks whether an API attribute is safe to use as one state ID segment.
 *
 * @param {string} name Attribute name.
 * @returns {boolean} Whether the name is supported.
 */
function isValidAttributeName(name) {
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

/**
 * Reserves an attribute name unless its normalized state ID already exists.
 *
 * @param {string} name Raw Traccar attribute name.
 * @param {Set<string>} usedNames State IDs already generated for this device.
 * @returns {boolean} Whether this name can be used.
 */
function claimAttributeName(name, usedNames) {
    if (!isValidAttributeName(name)) {
        return false;
    }
    const stateId = name.split(/(?=[A-Z])/).join('_').toLowerCase();
    if (usedNames.has(stateId)) {
        return false;
    }
    usedNames.add(stateId);
    return true;
}

/**
 * Converts object-like API attribute values to JSON strings.
 *
 * @param {unknown} value Attribute value.
 * @returns {unknown} Serializable state value.
 */
function serializeAttributeValue(value) {
    return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
}

/**
 * Selects stale direct child channels without including their nested states.
 *
 * @param {object[]} rows Object database rows.
 * @param {string} prefix Collection object ID prefix.
 * @param {(number|string)[]} currentIds Current Traccar IDs.
 * @returns {string[]} Stale channel IDs.
 */
function getStaleChannelIds(rows, prefix, currentIds) {
    const current = new Set(currentIds.map(String));
    return rows
        .filter((row) => row.value?.type === 'channel' && row.id.startsWith(prefix))
        .filter((row) => !row.id.slice(prefix.length).includes('.'))
        .filter((row) => !current.has(row.id.slice(prefix.length)))
        .map((row) => row.id);
}

/**
 * Validates the configured poll interval and converts seconds to milliseconds.
 *
 * @param {number|string|undefined} value Configured interval.
 * @param {number} defaultInterval Fallback interval in seconds.
 * @param {number} minInterval Minimum interval in seconds.
 * @param {number} maxInterval Maximum interval in seconds.
 * @returns {number|null} Interval in milliseconds, or null for an invalid value.
 */
function getUpdateIntervalMs(value, defaultInterval, minInterval, maxInterval) {
    const interval = Number(value ?? defaultInterval);
    if (!Number.isFinite(interval) || interval < minInterval || interval > maxInterval) {
        return null;
    }
    return interval * 1000;
}

/**
 * Calculates a capped exponential reconnect delay.
 *
 * @param {number} attempts Number of previous retries.
 * @param {number} initialDelay Initial delay in milliseconds.
 * @param {number} maxDelay Maximum delay in milliseconds.
 * @returns {number} Delay in milliseconds.
 */
function getReconnectDelay(attempts, initialDelay, maxDelay) {
    return Math.min(initialDelay * (2 ** attempts), maxDelay);
}

/**
 * Validates the server scheme, hostname, and port before network requests.
 *
 * @param {string} scheme HTTP or HTTPS.
 * @param {string} address Server hostname or address.
 * @param {number|string} port Server port.
 * @returns {boolean} Whether the connection settings are valid.
 */
function isValidServerConfig(scheme, address, port) {
    if (!['http', 'https'].includes(scheme) || typeof address !== 'string' ||
        !address.trim() || /[/:?#\s]/.test(address) ||
        !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
        return false;
    }
    try {
        new URL(`${scheme}://${address}:${port}`);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    getGeoDeviceState,
    getReconnectDelay,
    getStaleChannelIds,
    getUpdateIntervalMs,
    claimAttributeName,
    isValidServerConfig,
    isValidAttributeName,
    isVersionNewer,
    parseFiniteNumber,
    resolveGeofenceNames,
    resolveGeofenceNamesWithRetry,
    serializeAttributeValue,
};
