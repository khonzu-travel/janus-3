/**
 * The script run in every fresh context before the user's script. It evaluates to a function that
 * the sandbox calls once with
 * `hostCall(op, argsJson) → replyJson`, `loadChai()` and the phase; those
 * stay in its closure, so the script sees only the globals defined here:
 * `pm`, `postman`, `tests`, `bru`, `req`, `res`, `test`, `expect`, `console`,
 * `require` and, in `after` scripts, the older Postman response globals.
 *
 * It is evaluated as its own file (`prelude.js`), so the user's script keeps
 * its own line numbers (`script.js`). chai is loaded the first time `expect`,
 * `pm.expect` or a `pm.response.to` assertion is used.
 */
export const PRELUDE_SOURCE = String.raw`(function (hostCall, loadChai, phase) {
  'use strict';
  var parse = JSON.parse;
  var stringify = JSON.stringify;
  var defineProperty = Object.defineProperty;
  var InternalErrorType = InternalError;
  var PromiseType = Promise;
  var global = globalThis;
  var after = phase === 'after';

  function call(op) {
    var args = [];
    for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
    var reply = parse(hostCall(op, stringify(args)));
    if (reply.e !== undefined) throw new Error(reply.e);
    return reply.v;
  }

  function unsupported(name) {
    return function () {
      call('unsupported', name, new Error().stack);
    };
  }

  function unsupportedGetter(target, property, name) {
    defineProperty(target, property, {
      get: function () {
        call('unsupported', name, new Error().stack);
      },
      enumerable: false,
      configurable: false,
    });
  }

  var chaiExports;
  function chai() {
    if (chaiExports === undefined) chaiExports = loadChai();
    return chaiExports;
  }

  function fail(message) {
    var AssertionError = chai().AssertionError;
    throw new AssertionError(message);
  }

  function isFatal(error) {
    return error instanceof InternalErrorType && error.message === 'out of memory';
  }

  function messageOf(error) {
    if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
    try {
      return String(error);
    } catch (_) {
      return 'the test failed';
    }
  }

  function isThenable(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
  }

  // Tests: an assertion thrown by the callback fails the test, not the script.
  function test(name, fn) {
    var id = call('test.begin', String(name));
    if (typeof fn !== 'function') {
      call('test.end', id, false, 'the test has no function');
      return;
    }
    var result;
    try {
      result = fn();
    } catch (error) {
      if (isFatal(error)) throw error;
      call('test.end', id, false, messageOf(error));
      return;
    }
    if (!isThenable(result)) {
      call('test.end', id, true);
      return;
    }
    PromiseType.resolve(result).then(
      function () {
        call('test.end', id, true);
      },
      function (error) {
        call('test.end', id, false, messageOf(error));
      },
    );
  }

  var tests = new Proxy(
    {},
    {
      set: function (target, key, value) {
        target[key] = value;
        call('tests.set', String(key), !!value);
        return true;
      },
    },
  );

  function format(value) {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (value instanceof Error) return value.name + ': ' + value.message;
    if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    try {
      if (typeof value === 'object' && value !== null) {
        var json = stringify(value);
        if (json !== undefined) return json;
      }
      return String(value);
    } catch (_) {
      return Object.prototype.toString.call(value);
    }
  }

  var consoleOpen = true;
  function logger(level) {
    return function () {
      if (!consoleOpen) return;
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(format(arguments[i]));
      consoleOpen = call('console', level, parts.join(' '));
    };
  }
  var console = { log: logger('log'), info: logger('info'), warn: logger('warn'), error: logger('error') };

  // Variables: reads run variables first; writes run variables only.
  function variableScope() {
    return {
      get: function (name) {
        return call('var.get', name);
      },
      set: function (name, value) {
        call('var.set', name, value);
      },
      unset: function (name) {
        call('var.unset', name);
      },
      has: function (name) {
        return call('var.has', name);
      },
      replaceIn: function (text) {
        return call('var.interpolate', text);
      },
    };
  }

  function current() {
    return call('req.get');
  }

  // pm.request.
  var url = {
    toString: function () {
      return current().url;
    },
    getQueryString: function () {
      return call('req.queryString');
    },
    query: {
      add: function (param) {
        call('req.addQuery', param);
      },
      remove: function (key) {
        call('req.removeQuery', key);
      },
    },
  };
  var requestHeaders = {
    get: function (name) {
      return call('req.header', name);
    },
    has: function (name) {
      return call('req.header', name) !== undefined;
    },
    add: function (header) {
      call('req.addHeader', header);
    },
    upsert: function (header) {
      call('req.upsertHeader', header);
    },
    remove: function (name) {
      call('req.removeHeader', name);
    },
    toObject: function () {
      return call('req.headersObject');
    },
  };
  var pmRequest = { headers: requestHeaders };
  defineProperty(pmRequest, 'method', {
    get: function () {
      return current().method;
    },
    set: function (method) {
      call('req.setMethod', method);
    },
    enumerable: true,
  });
  defineProperty(pmRequest, 'url', {
    get: function () {
      return url;
    },
    set: function (value) {
      call('req.setUrl', String(value));
    },
    enumerable: true,
  });
  defineProperty(pmRequest, 'body', {
    get: function () {
      var body = call('req.postmanBody');
      body.update = function (value) {
        call('req.updateBody', value);
      };
      body.toString = function () {
        return body.raw === undefined ? '' : body.raw;
      };
      return body;
    },
    enumerable: true,
  });

  // The response, read once; after scripts only.
  var response = after ? call('res.get') : undefined;
  function responseHeader(name) {
    var lower = String(name).toLowerCase();
    for (var i = 0; i < response.headers.length; i++) {
      if (response.headers[i][0].toLowerCase() === lower) return response.headers[i][1];
    }
    return undefined;
  }
  function responseHeaderObject(lowerCase) {
    var out = {};
    for (var i = 0; i < response.headers.length; i++) {
      var name = lowerCase ? response.headers[i][0].toLowerCase() : response.headers[i][0];
      out[name] = out[name] === undefined ? response.headers[i][1] : out[name] + ', ' + response.headers[i][1];
    }
    return out;
  }
  function responseJson() {
    return parse(response.text);
  }
  function responseQuery(path) {
    return call('res.query', path === undefined ? '' : String(path));
  }

  function pmResponse() {
    var be = {};
    defineProperty(be, 'ok', {
      get: function () {
        if (response.status < 200 || response.status > 299) {
          fail('expected response code to be 2XX but found ' + response.status);
        }
        return be;
      },
    });
    return {
      code: response.status,
      status: response.statusText,
      responseTime: response.timeMs,
      headers: {
        get: responseHeader,
        has: function (name) {
          return responseHeader(name) !== undefined;
        },
        toObject: function () {
          return responseHeaderObject(false);
        },
      },
      text: function () {
        return response.text;
      },
      json: responseJson,
      to: {
        have: {
          status: function (expected) {
            if (typeof expected === 'string') {
              if (response.statusText !== expected) {
                fail('expected response to have status reason ' + expected + ' but got ' + response.statusText);
              }
            } else if (response.status !== expected) {
              fail('expected response to have status code ' + expected + ' but got ' + response.status);
            }
          },
          header: function (name, value) {
            var actual = responseHeader(name);
            if (actual === undefined) fail('expected response to have header ' + name);
            if (arguments.length > 1 && actual !== String(value)) {
              fail('expected response to have header ' + name + ' with value ' + value + ' but got ' + actual);
            }
          },
          jsonBody: function (path, value) {
            try {
              responseJson();
            } catch (_) {
              fail('expected response body to be valid JSON');
            }
            if (arguments.length === 0) return;
            var found = responseQuery(path);
            if (!found.found) fail('expected response body JSON to have path ' + path);
            if (arguments.length > 1) chai().expect(found.value, 'response body JSON at ' + path).to.deep.equal(value);
          },
        },
        be: be,
      },
    };
  }

  // pm.
  var info = call('info');
  var environment = variableScope();
  defineProperty(environment, 'name', {
    get: function () {
      return call('env.name');
    },
    enumerable: true,
  });
  var pm = {
    variables: variableScope(),
    environment: environment,
    collectionVariables: variableScope(),
    request: pmRequest,
    info: {
      requestName: info.requestName,
      requestId: info.requestId,
      eventName: after ? 'test' : 'prerequest',
    },
    test: test,
    sendRequest: unsupported('pm.sendRequest'),
    execution: { setNextRequest: unsupported('pm.execution.setNextRequest') },
    cookies: {},
  };
  unsupportedGetter(pm, 'visualizer', 'pm.visualizer');
  unsupportedGetter(pm.cookies, 'jar', 'pm.cookies.jar');
  var pmResponseValue = after ? pmResponse() : undefined;
  defineProperty(pm, 'response', {
    get: function () {
      if (!after) throw new Error('pm.response is not available in a before script');
      return pmResponseValue;
    },
    enumerable: true,
  });
  defineProperty(pm, 'expect', {
    get: function () {
      return chai().expect;
    },
    enumerable: true,
  });

  var postman = {
    setEnvironmentVariable: function (name, value) {
      call('var.set', name, value);
    },
    getEnvironmentVariable: function (name) {
      return call('var.get', name);
    },
    setNextRequest: unsupported('postman.setNextRequest'),
  };

  // bru, req and res.
  var bru = {
    getVar: function (name) {
      return call('var.get', name);
    },
    setVar: function (name, value) {
      call('var.set', name, value);
    },
    hasVar: function (name) {
      return call('var.has', name);
    },
    deleteVar: function (name) {
      call('var.unset', name);
    },
    getEnvVar: function (name) {
      return call('var.scope', 'environment', name);
    },
    setEnvVar: function (name, value) {
      call('var.set', name, value);
    },
    getRequestVar: function (name) {
      return call('var.scope', 'request', name);
    },
    getFolderVar: function (name) {
      return call('var.scope', 'folder', name);
    },
    getCollectionVar: function (name) {
      return call('var.scope', 'collection', name);
    },
    interpolate: function (value) {
      if (typeof value === 'string') return call('var.interpolate', value);
      if (value === undefined || value === null) return value;
      var text = call('var.interpolate', stringify(value));
      try {
        return parse(text);
      } catch (_) {
        return text;
      }
    },
    getEnvName: function () {
      return call('env.name');
    },
    sendRequest: unsupported('bru.sendRequest'),
    runRequest: unsupported('bru.runRequest'),
    setNextRequest: unsupported('bru.setNextRequest'),
  };

  var brunoRequest = {
    getUrl: function () {
      return current().url;
    },
    setUrl: function (value) {
      call('req.setUrl', value);
    },
    getMethod: function () {
      return current().method;
    },
    setMethod: function (method) {
      call('req.setMethod', method);
    },
    getHeader: function (name) {
      return call('req.header', name);
    },
    setHeader: function (name, value) {
      call('req.setHeader', name, value);
    },
    deleteHeader: function (name) {
      call('req.removeHeader', name);
    },
    getHeaders: function () {
      return call('req.headersObject');
    },
    setHeaders: function (headers) {
      call('req.setHeaders', headers);
    },
    getBody: function () {
      return call('req.brunoBody');
    },
    setBody: function (body) {
      call('req.setBody', body);
    },
  };
  defineProperty(brunoRequest, 'url', { get: brunoRequest.getUrl, enumerable: true });
  defineProperty(brunoRequest, 'method', { get: brunoRequest.getMethod, enumerable: true });
  defineProperty(brunoRequest, 'headers', { get: brunoRequest.getHeaders, enumerable: true });
  defineProperty(brunoRequest, 'body', { get: brunoRequest.getBody, enumerable: true });

  function brunoResponse() {
    var body;
    try {
      body = responseJson();
    } catch (_) {
      body = response.text;
    }
    var headers = responseHeaderObject(true);
    var res = function (path) {
      var found = responseQuery(path);
      return found.found ? found.value : undefined;
    };
    res.status = response.status;
    res.statusText = response.statusText;
    res.headers = headers;
    res.body = body;
    res.responseTime = response.timeMs;
    res.getStatus = function () {
      return response.status;
    };
    res.getStatusText = function () {
      return response.statusText;
    };
    res.getHeader = function (name) {
      return headers[String(name).toLowerCase()];
    };
    res.getHeaders = function () {
      return headers;
    };
    res.getBody = function () {
      return body;
    };
    res.getResponseTime = function () {
      return response.timeMs;
    };
    return res;
  }

  function define(name, value) {
    defineProperty(global, name, { value: value, writable: true, configurable: true, enumerable: false });
  }

  define('pm', pm);
  define('postman', postman);
  define('tests', tests);
  define('bru', bru);
  define('req', brunoRequest);
  define('test', test);
  define('console', console);
  define('require', function require() {
    call('unsupported', 'require', new Error().stack);
  });
  defineProperty(global, 'expect', {
    get: function () {
      return chai().expect;
    },
    set: function (value) {
      define('expect', value);
    },
    configurable: true,
    enumerable: false,
  });
  if (after) {
    var headerObject = responseHeaderObject(false);
    define('res', brunoResponse());
    define('responseBody', response.text);
    define('responseCode', { code: response.status, name: response.statusText, detail: response.statusText });
    define('responseHeaders', headerObject);
    define('responseTime', response.timeMs);
  }
})`;
