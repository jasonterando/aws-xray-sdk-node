/**
 * @module fetch_p
 */

/**
 * This module patches the global fetch instance for NodeJS 18+
 */

var contextUtils = require('../context_utils');
var Utils = require('../utils');

var logger = require('../logger');

/**
 * Wrap fetch either in global instance for recent NodeJS or the node-fetch module for older versions,
 *  to automatically capture information for the segment.
 * This patches the built-in fetch function globally.
 * @param {boolean} downstreamXRayEnabled - when true, adds a "traced:true" property to the subsegment
 *   so the AWS X-Ray service expects a corresponding segment from the downstream service.
 * @param {function} subsegmentCallback - a callback that is called with the subsegment, the Node.js
 *   http.ClientRequest, the Node.js http.IncomingMessage (if a response was received) and any error issued,
 *   allowing custom annotations and metadata to be added.
 *   to be added to the subsegment.
 * @alias module:fetch_p.captureFetch
 */
function captureFetch(downstreamXRayEnabled, subsegmentCallback) {
  if ('fetch' in globalThis) {
    if (!globalThis.__fetch) {
      globalThis.__fetch = globalThis.fetch;
      globalThis.fetch = exports._fetchEnableCapture(globalThis.__fetch, globalThis.Request,
        downstreamXRayEnabled, subsegmentCallback);
    }
    return globalThis.fetch;
  }
  return exports.captureFetchModule(require('node-fetch'), downstreamXRayEnabled, subsegmentCallback);
}

/**
 * Wrap fetch module to capture information for the segment.
 * This patches the fetch function distributed in node-fetch package.
 * @param {fetch} module - The fetch module
 * @param {boolean} downstreamXRayEnabled - when true, adds a "traced:true" property to the subsegment
 *   so the AWS X-Ray service expects a corresponding segment from the downstream service.
 * @param {function} subsegmentCallback - a callback that is called with the subsegment, the Node.js
 *   http.ClientRequest, the Node.js http.IncomingMessage (if a response was received) and any error issued,
 *   allowing custom annotations and metadata to be added.
 *   to be added to the subsegment.
 * @alias module:fetch_p.captureFetchModule
 */
function captureFetchModule(module, downstreamXRayEnabled, subsegmentCallback) {
  if (!module.default) {
    logger.getLogger().warn('X-ray capture did not find fetch function in module');
    return null;
  }
  if (!module.__fetch) {
    module.__fetch = module.default;
    module.default = exports._fetchEnableCapture(module.__fetch, module.Request,
      downstreamXRayEnabled, subsegmentCallback);
  }
  return module.default;
}

const enableCapture = function enableCapture(baseFetchFunction, requestClass, downstreamXRayEnabled, subsegmentCallback) {
  //  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

  var overridenFetchAsync = async (...args) => {
    this.downstreamXRayEnabled = !!downstreamXRayEnabled;
    this.subsegmentCallback = subsegmentCallback;
    // Standardize request information
    const request = typeof args[0] === 'object' ?
      args[0] :
      new requestClass(...args);

    // Facilitate the addition of Segment information via the request arguments
    const params = args.length > 1 ? args[1] : {};

    // Short circuit if the HTTP is already being captured
    if (request.headers.has('X-Amzn-Trace-Id')) {

      return await baseFetchFunction(...args);
    }

    const url = new URL(request.url);
    const isAutomaticMode = contextUtils.isAutomaticMode();

    const parent = contextUtils.resolveSegment(contextUtils.resolveManualSegmentParams(params));
    const hostname = url.hostname || url.host || 'Unknown host';

    if (!parent) {
      let output = '[ host: ' + hostname +
        (request.method ? (', method: ' + request.method) : '') +
        ', path: ' + url.pathname + ' ]';

      if (isAutomaticMode) {
        logger.getLogger().info('RequestInit for request ' + output +
          ' is missing the sub/segment context for automatic mode. Ignoring.');
      } else {
        logger.getLogger().info('RequestInit for request ' + output +
          ' requires a segment object on the options params as "XRaySegment" for tracing in manual mode. Ignoring.');
      }

      // Options are not modified, only parsed for logging. We can pass in the original arguments.
      return await baseFetchFunction(...args);
    }

    let subsegment;
    if (parent.notTraced) {
      subsegment = parent.addNewSubsegmentWithoutSampling(hostname);
    } else {
      subsegment = parent.addNewSubsegment(hostname);
    }

    subsegment.namespace = 'remote';

    request.headers.set('X-Amzn-Trace-Id',
      'Root=' + (parent.segment ? parent.segment : parent).trace_id +
      ';Parent=' + subsegment.id +
      ';Sampled=' + (subsegment.notTraced ? '0' : '1'));

    // Set up fetch call and capture any thrown errors
    const capturedFetch = async () => {
      const requestClone = request.clone();
      let response;
      try {
        response = await baseFetchFunction(requestClone);

        if (this.subsegmentCallback) {
          this.subsegmentCallback(subsegment, requestClone, response);
        }

        const statusCode = response.status;
        if (statusCode === 429) {
          subsegment.addThrottleFlag();
        }

        const cause = Utils.getCauseTypeFromHttpStatus(statusCode);
        if (cause) {
          subsegment[cause] = true;
        }

        subsegment.addRemoteRequestData(requestClone, response, this.downstreamXRayEnabled);
        subsegment.close();
        return response;
      } catch (e) {
        if (this.subsegmentCallback) {
          this.subsegmentCallback(subsegment, requestClone, response, e);
        }
        const madeItToDownstream = (e.code !== 'ECONNREFUSED');
        subsegment.addErrorFlag();
        subsegment.addRemoteRequestData(requestClone, response, madeItToDownstream && this.downstreamXRayEnabled);
        subsegment.close(e);
        throw (e);
      }
    };

    if (isAutomaticMode) {
      const session = contextUtils.getNamespace();
      return await session.runPromise(async () => {
        contextUtils.setSegment(subsegment);
        return await capturedFetch();
      });
    } else {
      return await capturedFetch();
    }
  };

  return overridenFetchAsync;
};

module.exports.captureFetch = captureFetch;
module.exports.captureFetchModule = captureFetchModule;
module.exports._fetchEnableCapture = enableCapture;
