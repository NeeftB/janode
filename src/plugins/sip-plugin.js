'use strict';

/**
 * This module contains the implementation of the SIP plugin (ref. {@link https://janus.conf.meetecho.com/docs/sip.html}).
 * @module sip-plugin
 */

import Handle from '../handle.js';
import { JANODE } from '../protocol.js';

/* The plugin ID exported in the plugin descriptor */
const PLUGIN_ID = 'janus.plugin.sip';

/* These are the requests defined for the Janus SIP plugin API */
const REQUEST_REGISTER = 'register';
const REQUEST_CALL = 'call';
const REQUEST_ACCEPT = 'accept';
const REQUEST_HANGUP = 'hangup';
const REQUEST_DECLINE = 'decline';

/* These are the events/responses that the Janode plugin will manage */
/* Some of them will be exported in the plugin descriptor */
const PLUGIN_EVENT = {
  REGISTERED: 'sip_registered',
  REGISTERING: 'sip_registering',
  CALLING: 'sip_calling',
  RINGING: 'sip_ringing',
  PROCEEDING: 'sip_proceeding',
  INCOMING: 'sip_incoming',
  HANGUP: 'sip_hangup',
  HANGINGUP: 'sip_hangingup',
  DECLINING: 'declining',
  ACCEPTED: 'sip_accepted',
  ERROR: 'sip_error',
  ERROR_EVENT: 'sip_error_event',
};

/**
 * The class implementing the SIP plugin (ref. {@link https://janus.conf.meetecho.com/docs/sip.html}).<br>
 *
 * It extends the base Janode Handle class and overrides the base "handleMessage" method.<br>
 *
 * Moreover it defines some methods to support SIP operations.<br>
 *
 * @hideconstructor
 */
class SipHandle extends Handle {
  /**
   * Create a Janode SIP handle.
   *
   * @param {module:session~Session} session - A reference to the parent session
   * @param {number} id - The handle identifier
   */
  constructor(session, id) {
    super(session, id);
    this._pendingRegister = null;
    this._pendingCalls = {};

    this.on(JANODE.EVENT.HANDLE_HANGUP, _ => {
      this._pendingRegister = null;
      this._pendingCalls = {};
    });
    this.on(JANODE.EVENT.HANDLE_DETACHED, _ => {
      this._pendingRegister = null;
      this._pendingCalls = {};
    });
  }

  /**
   * The custom "handleMessage" needed for handling SIP plugin messages.
   *
   * @private
   * @param {object} janus_message
   * @returns {object} A falsy value for unhandled events, a truthy value for handled events
   */
  handleMessage(janus_message) {
    const { plugindata, jsep, transaction } = janus_message;
    if (plugindata && plugindata.data && plugindata.data.sip) {
      /**
       * @type {SipData}
       */
      const message_data = plugindata.data;
      const { sip, result, call_id, error, error_code } = message_data;

      /* The event can not be recognized, return a falsy value */
      if (!error && sip !== 'event' && !result.event)
        return null;

      /* Prepare an object for the output Janode event */
      const janode_event = {
        /* The name of the resolved event */
        event: null,
        /* The event payload */
        data: {},
      };

      /* Add JSEP data if available */
      if (jsep) janode_event.data.jsep = jsep;
      /* Add call id information if available */
      if (call_id) {
        janode_event.data.call_id = call_id;
        this._pendingCalls[call_id] = this._pendingCalls[call_id] || {};
      }

      /* Use the "janode" property to store the output event */
      janus_message._janode = janode_event;

      /* Plugin messaging error (not related to SIP requests) */
      if (error) {
        janode_event.event = PLUGIN_EVENT.ERROR;
        janode_event.data = new Error(`${error_code} ${error}`);
        /* In case of error, close a transaction */
        this.closeTransactionWithError(transaction, janode_event.data);
        return janode_event;
      }

      /* Emit the event to the application */
      let emit = false;

      /* Close the related janus transaction */
      const CLOSE_TX_NO = 0;
      const CLOSE_TX_SUCCESS = 1;
      const CLOSE_TX_ERROR = -1;
      let closeTx = CLOSE_TX_NO;
      let txId = transaction;

      switch (result.event) {

        /* Registering event */
        case 'registering':
          janode_event.event = PLUGIN_EVENT.REGISTERING;
          closeTx = CLOSE_TX_NO;
          emit = true;
          break;

        case 'registration_failed':
          janode_event.event = PLUGIN_EVENT.ERROR_EVENT;
          janode_event.data = new Error(`${result.code} ${result.reason}`);
          closeTx = CLOSE_TX_ERROR;
          txId = transaction || this._pendingRegister;
          emit = false;
          break;

        case 'registered':
          janode_event.event = PLUGIN_EVENT.REGISTERED;
          janode_event.data.username = result.username;
          janode_event.data.register_sent = result.register_sent;
          closeTx = CLOSE_TX_SUCCESS;
          txId = transaction || this._pendingRegister;
          emit = false;
          break;

        case 'calling':
          janode_event.event = PLUGIN_EVENT.CALLING;
          closeTx = CLOSE_TX_NO;
          emit = true;
          break;

        case 'ringing':
          janode_event.event = PLUGIN_EVENT.RINGING;
          closeTx = CLOSE_TX_NO;
          emit = true;
          break;

        case 'proceeding':
          janode_event.event = PLUGIN_EVENT.PROCEEDING;
          closeTx = CLOSE_TX_NO;
          emit = true;
          break;

        case 'incomingcall':
          janode_event.event = PLUGIN_EVENT.INCOMING;
          this._pendingCalls[call_id].incoming = result.username;
          janode_event.data.username = result.username;
          janode_event.data.callee = result.callee;
          janode_event.data.display_name = result.displayname || undefined;
          closeTx = CLOSE_TX_NO;
          emit = true;
          break;

        case 'hangup':
          /* There is a pending call without a reply */
          if (!this._pendingCalls[call_id].accepted && !this._pendingCalls[call_id].declined && !this._pendingCalls[call_id].incoming) {
            janode_event.event = PLUGIN_EVENT.ERROR_EVENT;
            janode_event.data = new Error(`${result.code} ${result.reason}`);
            closeTx = CLOSE_TX_ERROR;
          }
          /* Async hangup */
          else {
            janode_event.event = PLUGIN_EVENT.HANGUP;
            closeTx = CLOSE_TX_NO;
            emit = true;
          }
          delete this._pendingCalls[call_id];
          break;

        case 'hangingup':
          janode_event.event = PLUGIN_EVENT.HANGINGUP;
          closeTx = CLOSE_TX_SUCCESS;
          emit = false;
          break;

        case 'declining':
          janode_event.event = PLUGIN_EVENT.DECLINING;
          this._pendingCalls[call_id].declined = true;
          closeTx = CLOSE_TX_SUCCESS;
          emit = false;
          break;

        case 'accepted':
          janode_event.event = PLUGIN_EVENT.ACCEPTED;
          janode_event.data.username = result.username || this._pendingCalls[call_id].incoming;
          this._pendingCalls[call_id].accepted = true;
          closeTx = CLOSE_TX_SUCCESS;
          emit = false;
          break;
      }

      /* The event has been handled */
      if (janode_event.event) {
        if (closeTx === CLOSE_TX_SUCCESS)
          this.closeTransactionWithSuccess(txId, janus_message);
        if (closeTx === CLOSE_TX_ERROR)
          this.closeTransactionWithError(txId, janode_event.data);
        if (emit)
          this.emit(janode_event.event, janode_event.data);
        return janode_event;
      }
    }

    /* The event has not been handled, return a falsy value */
    return null;
  }

  /**
   * Register to the SIP plugin (sending of a SIP REGISTER is optional).
   *
   * @param {object} params
   * @param {string} [params.type] - optional SIP session type, either "guest" or "helper"
   * @param {boolean} [params.send_register] - True to send a SIP register
   * @param {boolean} [params.force_udp] - True to force UDP for the SIP messaging
   * @param {boolean} [params.force_tcp] - True to force TCP for the SIP messaging
   * @param {boolean} [params.sips] - True to configure a SIPS URI too when registering
   * @param {boolean} [params.rfc2543_cancel] - True to configure sip client to CANCEL pending INVITEs without having received a provisional response
   * @param {string} params.username - The SIP URI to register
   * @param {string} [params.secret] - The password to use, if any
   * @param {string} [params.ha1_secret] - The prehashed password to use, if any
   * @param {string} [params.display_name] - The display name to use when sending SIP REGISTER
   * @param {string} [params.proxy] - The server to register at (not needed for guests)
   * @param {string} [params.outbound_proxy] - The server to register at (not needed for guests)
   * @param {number} [params.register_ttl] - The number of seconds after which the registration should expire
   * 
   * @returns {Promise<module:sip-plugin~SIP_EVENT_REGISTERED>}
   */
  async register({ type, send_register, force_udp, force_tcp, sips, rfc2543_cancel, username, secret, ha1_secret, display_name, proxy, outbound_proxy, register_ttl }) {
    const body = {
      request: REQUEST_REGISTER,
      username,
    };

    if (typeof type === 'string') body.type = type;
    if (typeof send_register === 'boolean') body.send_register = send_register;
    if (typeof force_udp === 'boolean') body.force_udp = force_udp;
    if (typeof force_tcp === 'boolean') body.force_tcp = force_tcp;
    if (typeof sips === 'boolean') body.sips = sips;
    if (typeof rfc2543_cancel === 'boolean') body.rfc2543_cancel = rfc2543_cancel;
    if (typeof secret === 'string') body.secret = secret;
    if (typeof ha1_secret === 'string') body.ha1_secret = ha1_secret;
    if (typeof display_name === 'string') body.display_name = display_name;
    if (typeof proxy === 'string') body.proxy = proxy;
    if (typeof outbound_proxy === 'string') body.outbound_proxy = outbound_proxy;
    if (typeof register_ttl === 'number') body.register_ttl = register_ttl;

    const request = {
      janus: 'message',
      body,
    };
    this.decorateRequest(request);
    this._pendingRegister = request.transaction;

    const response = await this.sendRequest(request, 10000);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.REGISTERED) {
      evtdata.username = username;
      return evtdata;
    }
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Start a SIP call.
   * 
   * @param {object} params
   * @param {string} params.uri - The SIP URI to call
   * @param {string} [params.call_id] - The user-defined value of Call-ID SIP header used in all SIP requests throughout the call
   * @param {string} [params.authuser] - The username to use to authenticate as to call, only needed in case authentication is needed and no REGISTER was sent
   * @param {string} [params.secret] - The password to use for authentication, if any
   * @param {string} [params.ha1_secret] - The prehashed password to use for authentication, if any
   * @param {RTCSessionDescription} params.jsep - JSEP offer
   * @returns {Promise<module:sip-plugin~SIP_EVENT_ACCEPTED>}
   */
  async call({ uri, call_id, authuser, secret, ha1_secret, jsep }) {
    if (typeof jsep === 'object' && jsep && jsep.type !== 'offer') {
      const error = new Error('jsep must be an offer');
      return Promise.reject(error);
    }

    const body = {
      request: REQUEST_CALL,
      uri,
    };

    if (typeof call_id === 'string') body.call_id = call_id;
    if (typeof authuser === 'string') body.authuser = authuser;
    if (typeof secret === 'string') body.secret = secret;
    if (typeof ha1_secret === 'string') body.ha1_secret = ha1_secret;

    const request = {
      janus: 'message',
      body,
      jsep,
    };
    this.decorateRequest(request);

    const response = await this.sendRequest(request, 10000);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.ACCEPTED)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  /**
   * Accept an incoming SIP call.
   * 
   * @param {object} params
   * @param {RTCSessionDescription} params.jsep - JSEP answer
   * @returns {Promise<module:sip-plugin~SIP_EVENT_ACCEPTED>}
   */
  async accept({ jsep }) {
    if (typeof jsep === 'object' && jsep && jsep.type !== 'answer') {
      const error = new Error('jsep must be an answer');
      return Promise.reject(error);
    }
    const body = {
      request: REQUEST_ACCEPT,
    };

    const request = {
      janus: 'message',
      body,
      jsep,
    };
    this.decorateRequest(request);

    const response = await this.sendRequest(request, 10000);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.ACCEPTED)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  async sip_hangup() {
    const body = {
      request: REQUEST_HANGUP,
    };

    const request = {
      janus: 'message',
      body,
    };
    this.decorateRequest(request);

    const response = await this.sendRequest(request, 10000);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.HANGINGUP)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }

  async decline() {
    const body = {
      request: REQUEST_DECLINE,
    };

    const request = {
      janus: 'message',
      body,
    };
    this.decorateRequest(request);

    const response = await this.sendRequest(request, 10000);
    const { event, data: evtdata } = response._janode || {};
    if (event === PLUGIN_EVENT.DECLINING)
      return evtdata;
    const error = new Error(`unexpected response to ${body.request} request`);
    throw (error);
  }
}

/**
 * The payload of the plugin message (cfr. Janus docs).
 * {@link https://janus.conf.meetecho.com/docs/sip.html}
 *
 * @private
 * @typedef {object} SipData
 */

/**
 * The event notifying a REGISTER is in progress
 * 
 * @typedef {object} SIP_EVENT_REGISTERING
 */

/**
 * The success event for a REGISTER request
 * 
 * @typedef {object} SIP_EVENT_REGISTERED
 * @property {string} username
 * @property {boolean} register_sent
 */

/**
 * The exported plugin descriptor.
 *
 * @type {object}
 * @property {string} id - The plugin identifier used when attaching to Janus
 * @property {module:sip-plugin~SipHandle} Handle - The custom class implementing the plugin
 * @property {object} EVENT - The events emitted by the plugin
 * @property {string} EVENT.SIP_REGISTERING {@link module:sip-plugin~SIP_REGISTERING}
 */
export default {
  id: PLUGIN_ID,
  Handle: SipHandle,
  EVENT: {
    /**
     * @event module:sip-plugin~SipHandle#event:SIP_REGISTERING
     * @type {module:sip-plugin~SIP_EVENT_REGISTERING}
     */
    SIP_REGISTERING: PLUGIN_EVENT.REGISTERING,
    SIP_CALLING: PLUGIN_EVENT.CALLING,
    SIP_RINGING: PLUGIN_EVENT.RINGING,
    SIP_PROCEEDING: PLUGIN_EVENT.PROCEEDING,
    SIP_INCOMING: PLUGIN_EVENT.INCOMING,
    SIP_HANGUP: PLUGIN_EVENT.HANGUP,
  },
};