/*global Components: false */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 *  Module for interfacing to pEp (Enigmail-specific functions)
 */


const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("resource://enigmail/core.jsm"); /*global EnigmailCore: false */
Cu.import("resource://enigmail/pEp.jsm"); /*global EnigmailpEp: false */
Cu.import("resource://enigmail/pEpListener.jsm"); /*global EnigmailpEpListener: false */
Cu.import("resource://enigmail/prefs.jsm"); /*global EnigmailPrefs: false */
Cu.import("resource://enigmail/log.jsm"); /*global EnigmailLog: false */
Cu.import("resource://enigmail/mime.jsm"); /*global EnigmailMime: false */
Cu.import("resource://enigmail/promise.jsm"); /*global Promise: false */
Cu.import("resource://enigmail/rng.jsm"); /*global EnigmailRNG: false */
Cu.import("resource://enigmail/lazy.jsm"); /*global EnigmailLazy: false */
Cu.import("resource://enigmail/streams.jsm"); /*global EnigmailStreams: false */
Cu.import("resource://enigmail/pEpMessageHist.jsm"); /*global EnigmailPEPMessageHist: false */
Cu.import("resource://enigmail/addrbook.jsm"); /*global EnigmailAddrbook: false */
Cu.import("resource://enigmail/locale.jsm"); /*global EnigmailLocale: false */
Cu.import("resource://enigmail/funcs.jsm"); /*global EnigmailFuncs: false */
Cu.import("resource://enigmail/pEpFilter.jsm"); /*global EnigmailPEPFilter: false */
Cu.import("resource://enigmail/subprocess.jsm"); /*global subprocess: false */
Cu.import("resource://enigmail/installPep.jsm"); /*global EnigmailInstallPep: false */
Cu.import("resource://gre/modules/jsmime.jsm"); /*global jsmime: false*/
Cu.import("resource://enigmail/pEpKeySync.jsm"); /*global EnigmailPEPKeySync: false */
Cu.import("resource://enigmail/timer.jsm"); /*global EnigmailTimer: false */


const getFiles = EnigmailLazy.loader("enigmail/files.jsm", "EnigmailFiles");


// pEp JSON Server executable name
const PEP_SERVER_EXECUTABLE = "pep-json-server";

var gPepVersion = null;
var gSecurityToken = null;
var gPepAvailable = null;
var gPepListenerPort = -1;
var gOwnIdentities = [];

var EXPORTED_SYMBOLS = ["EnigmailPEPAdapter"];


function pepCallback(dataObj) {
  EnigmailLog.DEBUG("pEpAdapter.jsm: pepCallback()\n");

  if ("method" in dataObj) {
    switch (dataObj.method) {
      case "messageToSend":
        EnigmailLog.DEBUG("pEpAdapter.jsm: pepCallback: messageToSend\n");

        EnigmailPEPKeySync.sendMessage(dataObj.params[0]);
        return 0;
      case "notifyHandshake":
        EnigmailLog.DEBUG("pEpAdapter.jsm: pepCallback: notifyHandshake\n");

        EnigmailPEPKeySync.notifyHandshake(dataObj.params);
        return 0;
    }
  }

  return 1;
}

function startListener() {

  EnigmailLog.DEBUG("pEpAdapter.jsm: startListener():\n");
  gSecurityToken = EnigmailRNG.generateRandomString(40);

  gPepListenerPort = EnigmailpEpListener.createListener(pepCallback, gSecurityToken);

  if (gPepListenerPort < 0) {
    EnigmailLog.DEBUG("pEpAdapter.jsm: startListener: could not open socket\n");
    return;
  }

  EnigmailpEp.registerListener(gPepListenerPort, gSecurityToken).then(function _ok(data) {
    EnigmailLog.DEBUG("pEpAdapter.jsm: startListener: registration with pEp OK\n");

  }).catch(function _fail(data) {
    EnigmailLog.DEBUG("pEpAdapter.jsm: startListener: registration with pEp failed\n");
  });
}


var EnigmailPEPAdapter = {

  pep: EnigmailpEp,

  filter: EnigmailPEPFilter,

  /**
   * Get the pEp JSON server version number.
   *
   * @return String:
   *     - null if the module is not initialized
   *     - a non-empty string if pEp is available
   *     - "" in case pEp is not available
   */
  getPepVersion: function() {
    return gPepVersion;
  },

  /**
   * Determine if pEp is available
   *
   * @return: Boolean: true - pEp is available / false - pEp is not usable
   */
  usingPep: function() {
    if (!this.getPepJuniorMode()) return false;

    if ((typeof(gPepVersion) === "string") && gPepVersion.length > 0) {
      return true;
    }

    return false;
  },

  /**
   * Determine if the pEp JSON adapter is available at all
   *
   * @param attemptInstall: Boolean - try to install pEp if possible
   *
   * @return Boolean - true if pEp is available / false otherwise
   */
  isPepAvailable: function(attemptInstall = true) {
    EnigmailLog.DEBUG("pEpAdapter.jsm: isPepAvailable()\n");

    if (gPepAvailable === null) {
      gPepAvailable = false;
      let execFile = getFiles().resolvePathWithEnv(PEP_SERVER_EXECUTABLE);
      if (execFile && execFile.exists() && execFile.isExecutable()) {
        EnigmailCore.getService(null, true);
        let pepVersionStr = "";

        let process = subprocess.call({
          command: execFile,
          arguments: ["--version"],
          charset: null,
          environment: EnigmailCore.getEnvList(),
          mergeStderr: false,
          stdin: function(stdin) {
            // do nothing
          },
          stdout: function(data) {
            pepVersionStr += data;
          },
          stderr: function(data) {
            // do nothing
          }
        });

        process.wait();
        EnigmailLog.DEBUG("pEpAdapter.jsm: isPepAvailable: got version '" + pepVersionStr + "'\n");
        if (pepVersionStr.search(/pEp JSON/i) >= 0) {
          gPepAvailable = true;
        }
      }
      else if (attemptInstall) {
        this.installPep();
      }
    }

    return gPepAvailable;
  },

  /**
   * try to download and install pEp (runs asynchronously!)
   */
  installPep: function() {
    EnigmailLog.DEBUG("pEpAdapter.jsm: installPep()\n");
    let progressListener = {
      onError: function(err) {
        EnigmailLog.DEBUG("pEpAdapter.jsm: installPep: got error " + err.type + "\n");
      },
      onInstalled: function() {
        EnigmailLog.DEBUG("pEpAdapter.jsm: installPep: installation completed\n");
        gPepAvailable = null;
      }
    };

    EnigmailInstallPep.startInstaller(progressListener);
  },

  /**
   * Determine if pEp should be used or Enigmail
   *
   * @return: Boolean: true - use pEp  / false - use Enigmail
   */
  getPepJuniorMode: function() {

    let mode = EnigmailPrefs.getPref("juniorMode");
    if (mode === 0) return false;

    // manual pEp or automatic mode
    if (mode === 2 || (!this.isAccountCryptEnabled())) {
      return this.isPepAvailable(true);
    }

    return false;
  },

  /**
   * Determine if any account is enabled for crypto (S/MIME or Enigmail)
   *
   * @return: Boolean: true if at least one account is enabled for S/MIME or Enigmail,
   *                   false otherwise
   */

  isAccountCryptEnabled: function() {
    // automatic mode: go through all identities
    let amService = Components.classes["@mozilla.org/messenger/account-manager;1"].getService(Ci.nsIMsgAccountManager);
    amService.LoadAccounts();
    let ids = amService.allIdentities;

    for (let i = 0; i < ids.length; i++) {
      let msgId = ids.queryElementAt(i, Ci.nsIMsgIdentity);

      if ((msgId.getUnicharAttribute("signing_cert_name") !== "") ||
        (msgId.getUnicharAttribute("encryption_cert_name") !== "") ||
        msgId.getBoolAttribute("enablePgp")) {
        return true;
      }
    }

    return false;
  },

  /**
   * Thunderbird shutdown callback (called from enigmail.js)
   */
  onShutdown: function() {
    EnigmailLog.DEBUG("pEpAdapter.jsm: onShutdown()\n");

    if (gPepListenerPort > 0) {

      let inspector = Cc["@mozilla.org/jsinspector;1"].createInstance(Ci.nsIJSInspector);

      EnigmailTimer.setTimeout(function _f() {
        // wait at most 1 second to continue shutdown
        if (gPepListenerPort > 0) {
          inspector.exitNestedEventLoop();
        }
      }, 1000);

      EnigmailpEp.unregisterListener(gPepListenerPort, gSecurityToken).then(function _ok(data) {
        EnigmailLog.DEBUG("pEpAdapter.jsm: onShutdown: de-registring from pEp OK\n");
        gPepListenerPort = -1;
        inspector.exitNestedEventLoop();
      }).catch(function _fail(data) {
        EnigmailLog.DEBUG("pEpAdapter.jsm: onShutdown: de-registring from pEp failed\n");
        gPepListenerPort = -1;
        inspector.exitNestedEventLoop();
      });

      // onShutdown should be synchronus in order for Thunderbird to wait
      // with shutting down until we're completed
      inspector.enterNestedEventLoop(0);
      EnigmailpEp.registerLogHandler(null);
    }
  },

  /**
   * Initialize the pEpAdapter (should be called during startup of application)
   *
   * no input and no retrun values
   */
  initialize: function() {
    EnigmailLog.DEBUG("pEpAdapter.jsm: initialize:\n");

    let self = this;
    let pEpMode = EnigmailPrefs.getPref("juniorMode");
    // force using Enigmail (do not use pEp)
    if (pEpMode === 0) return;

    EnigmailpEp.registerLogHandler(EnigmailLog.DEBUG);

    // automatic mode, with Crypto enabled (do not use pEp)
    if (this.isAccountCryptEnabled() && pEpMode !== 2) return;

    let execFile = getFiles().resolvePathWithEnv(PEP_SERVER_EXECUTABLE);
    if (execFile) EnigmailpEp.setServerPath(execFile.path);

    try {
      EnigmailpEp.getPepVersion().then(function _success(data) {
        EnigmailLog.DEBUG("pEpAdapter.jsm: initialize: success '" + JSON.stringify(data) + "'\n");
        if (typeof(data) === "string") {
          gPepVersion = data;
          startListener();
        }

        return EnigmailpEp.getGpgEnv();
      }).
      then(function _gotGpgEnv(gpgEnv) {
        EnigmailLog.DEBUG("pEpAdapter.jsm: initialize: got GnuPG env '" + JSON.stringify(gpgEnv) + "'\n");

        let envStr = "";
        if (gpgEnv && typeof gpgEnv === "object" && "gnupg_path" in gpgEnv) {

          EnigmailLog.DEBUG("pEpAdapter.jsm: initialize: got GnuPG path '" + gpgEnv.gnupg_path + "'\n");

          if (typeof(gpgEnv.gpg_agent_info) === "string" && gpgEnv.gpg_agent_info.length > 0) {
            envStr += "GPG_AGENT_INFO=" + gpgEnv.gpg_agent_info + "\n";
          }
          if (typeof(gpgEnv.gnupg_home) === "string" && gpgEnv.gnupg_home.length > 0) {
            envStr += "GNUPGHOME=" + gpgEnv.gnupg_home + "\n";
          }

          let enigmailSvc = Cc["@mozdev.org/enigmail/enigmail;1"].getService(Ci.nsIEnigmail);
          enigmailSvc.perferGpgPath(gpgEnv.gnupg_path);
          enigmailSvc.overwriteEnvVar(envStr);

          if (enigmailSvc.initialized) {
            enigmailSvc.reinitialize();
          }
          else {
            enigmailSvc.initialize(null, false);
          }
        }

        self.setOwnIdentities(0);
      }).
      catch(function failed(err) {
        EnigmailLog.DEBUG("pEpAdapter.jsm: initialize: error during pEp init:\n");
        EnigmailLog.DEBUG("   " + err.code + ": " + ("exception" in err && err.exception ? err.exception.toString() : err.message) + "\n");

        gPepVersion = "";
      });
    }
    catch (ex) {}
  },

  setOwnIdentities: function(accountNum) {
    let self = this;
    let accountManager = Cc["@mozilla.org/messenger/account-manager;1"].getService(Ci.nsIMsgAccountManager);
    let id;

    // pEp currently only supports 1 identity per account, we therefore only set the 1st id of each accunt
    if (accountManager.accounts.length > accountNum) {
      let ac = accountManager.accounts.queryElementAt(accountNum, Ci.nsIMsgAccount);
      try {
        id = ac.identities.queryElementAt(0, Ci.nsIMsgIdentity);
      }
      catch (ex) {
        id = null;
      }

      if (!id) {
        self.setOwnIdentities(accountNum + 1);
        return;
      }

      let pepId = {
        address: id.email.toLowerCase(),
        user_id: "",
        username: id.fullName
      };

      EnigmailLog.DEBUG("pEpAdapter.jsm: setOwnIdentities: " + id.identityName + "\n");
      self.pep.setMyself(pepId).then(
        function _ok(data) {
          if (data) {
            self.processOwnIdentity(data);
          }
          self.setOwnIdentities(accountNum + 1);
        }).catch(
        function _err(data) {
          EnigmailLog.DEBUG("pEpAdapter.jsm: setOwnIdentities: ERROR: '" + JSON.stringify(data) + "'\n");
        });
    }
    else {
      EnigmailLog.DEBUG("pEpAdapter.jsm: setOwnIdentities: done.\n");
    }
  },

  processOwnIdentity: function(identityData) {
    EnigmailLog.DEBUG("pEpAdapter.jsm: processOwnIdentity()\n");
    if ("result" in identityData) {
      let id = identityData.result.outParams[0];

      gOwnIdentities[id.address.toLowerCase()] = id;
    }
  },


  /**
   * get the pEp Identity of own emails (i.e. for those what we should have a secret key)
   * for a given email address.
   *
   * @param emailAddress: String - my own email address
   *
   * @return Object: pEp Identity or null (if not found)
   */
  getOwnIdentityForEmail: function(emailAddress) {
    emailAddress = emailAddress.toLowerCase();

    if (emailAddress in gOwnIdentities) {
      return gOwnIdentities[emailAddress];
    }

    return null;
  },

  /**
   * Get a MIME tree as String from the pEp-internal message object
   *
   * @param resObj: Object  - result object from encryption
   *
   * @return String - a MIME string, or "" if no message extracted
   */
  stripMsgHeadersFromEncryption: function(resObj) {
    let mimeStr = "";
    if (Array.isArray(resObj) && typeof(resObj[0]) === "string") {
      mimeStr = resObj[0];
    }

    let startPos = mimeStr.search(/\r?\n\r?\n/);

    if (startPos < 0) return "";

    let headers = Cc["@mozilla.org/messenger/mimeheaders;1"].createInstance(Ci.nsIMimeHeaders);
    headers.initialize(mimeStr.substring(0, startPos));

    let n = headers.headerNames;
    let printHdr = "";

    while (n.hasMore()) {
      let hdr = n.getNext();
      if (hdr.search(/^(from|to|mime-version)$/i) < 0) {
        printHdr += hdr + ": " + EnigmailMime.formatHeaderData(headers.extractHeader(hdr, true)) + "\r\n";
      }
    }

    return printHdr + "\r\n" + mimeStr.substr(startPos);
  },

  /**
   * Get the encryption quality rating for a list of recipients
   *
   * @param sender:     - Object msgIAddressObject   message sender
   * @param recipients: - Array of Object msgIAddressObject message recipients
   *
   * @return Number: quality of encryption (-3 ... 9)
   */
  getOutgoingMessageRating: function(sender, recipients) {
    let resultObj = null;
    let inspector = Cc["@mozilla.org/jsinspector;1"].createInstance(Ci.nsIJSInspector);

    let from = this.emailToPepPerson(sender);
    let to = [];

    if (recipients.length === 0) {
      return 0;
    }

    for (let i of recipients) {
      to.push(EnigmailPEPAdapter.emailToPepPerson(i));
    }

    EnigmailPEPAdapter.pep.outgoingMessageRating(from, to, "test").then(function _step2(res) {
      EnigmailLog.DEBUG("pEpAdapter.jsm: outgoingMessageRating: SUCCESS\n");
      if ((typeof(res) === "object") && ("result" in res)) {
        resultObj = res.result.outParams;
      }
      else
        EnigmailLog.DEBUG("pEpAdapter.jsm: outgoingMessageRating: typeof res=" + typeof(res) + "\n");


      if (inspector && inspector.eventLoopNestLevel > 0) {
        // unblock the waiting lock in finishCryptoEncapsulation
        inspector.exitNestedEventLoop();
      }

    }).catch(function _error(err) {
      EnigmailLog.DEBUG("pEpAdapter.jsm: outgoingMessageRating: ERROR\n");
      EnigmailLog.DEBUG(err.code + ": " + ("exception" in err ? err.exception.toString() : err.message) + "\n");

      if (inspector && inspector.eventLoopNestLevel > 0) {
        // unblock the waiting lock in finishCryptoEncapsulation
        inspector.exitNestedEventLoop();
      }
    });

    // wait here for PEP to terminate
    inspector.enterNestedEventLoop(0);

    if (resultObj && Array.isArray(resultObj) && "rating" in resultObj[0]) {
      return resultObj[0].rating;
    }
    return 3; // unencrypted
  },

  /**
   * Obtain a list of supported languages for trustwords
   *
   * @return Promise, delivering Array of Object:
   *            - short: 2-Letter ISO-Codes
   *            - long:  Language name in the language
   *            - desc:  Describing sentence in the language
   */
  getSupportedLanguages: function() {
    let deferred = Promise.defer();
    EnigmailpEp.getLanguageList().then(function _success(res) {
      let outArr = EnigmailpEp.processLanguageList(res);
      deferred.resolve(outArr);
    }).catch(function _err(err) {
      deferred.resolve([]);
    });

    return deferred.promise;
  },

  getIdentityForEmail: function(emailAddress) {
    let deferred = Promise.defer();
    EnigmailpEp.getIdentity(emailAddress, "TOFU_" + emailAddress).then(function _ok(data) {
      if (("result" in data) && typeof data.result === "object" && typeof data.result.outParams[0] === "object") {
        if ("username" in data.result.outParams[0] && data.result.outParams[0].username) {
          let u = jsmime.headerparser.parseAddressingHeader(data.result.outParams[0].username, true);
          if (Array.isArray(u) && u.length > 0) {
            data.result.outParams[0].username = u[0].name;
          }
        }
      }
      deferred.resolve(data);
    }).catch(function _err(data) {
      deferred.reject(data);
    });

    return deferred.promise;
  },

  /**
   * Convert an msgIAddressObject object into a pEpPerson object
   * If no name given, the name is looked up in the address book
   *
   * @param emailObj - Object msgIAddressObject
   *
   * @return pEpPerson object
   */
  emailToPepPerson: function(emailObj) {
    let p = {
      user_id: "",
      username: "unknown",
      address: ""
    };

    if (!emailObj) return p;

    if ("email" in emailObj) {
      p.address = emailObj.email;
    }

    if ("name" in emailObj && emailObj.name.length > 0) {
      p.username = emailObj.name;
    }
    else {
      let addr = EnigmailAddrbook.lookupEmailAddress(p.address);
      if (addr) {
        if (addr.card.displayName.length > 0) {
          p.username = addr.card.displayName;
        }
        else {
          p.username = (addr.card.firstName + " " + addr.card.lastName).trim();
        }
      }
    }

    if (p.username.length === 0 || p.username === "unknown") {
      p.username = p.address.replace(/@.*$/, "");
    }
    return p;
  },

  /**
   * Update the last sent date for PGP/MIME messages. We only do this such that
   * we don't unnecessarily process earlier inline-PGP messages
   */
  processPGPMIME: function(headerData) {
    EnigmailLog.DEBUG("pEpAdapter.jsm: processPGPMIME\n");
    if (!(("from" in headerData) && ("date" in headerData))) return;

    EnigmailPEPMessageHist.isLatestMessage(headerData.from.headerValue, headerData.date.headerValue).
    then(function _result(latestMessage) {
      EnigmailLog.DEBUG("pEpAdapter.jsm: processPGPMIME: " + latestMessage + "\n");
    }).catch(function _fail() {
      EnigmailLog.DEBUG("pEpAdapter.jsm: processPGPMIME: error\n");
    });
  },

  /**
   * Update the last sent date for inline-PGP messages. We do this to make sure
   * that pEp can potentially derive information from the message (such as extracting an
   * attached key).
   */
  processInlinePGP: function(msgUri, headerData) {
    EnigmailLog.DEBUG("pEpAdapter.jsm: processInlinePGP: " + msgUri + "\n");

    if (!("from" in headerData) && ("date" in headerData)) return;

    let stream = EnigmailStreams.newStringStreamListener(
      function analyzeData(data) {
        EnigmailLog.DEBUG("pEpAdapter.jsm: processInlinePGP: got " + data.length + " bytes\n");

        if (data.indexOf("From -") === 0) {
          // remove 1st line from Mails stored in msgbox format
          data = data.replace(/^From .*\r?\n/, "");
        }

        EnigmailpEp.decryptMimeString(data).
        then(function _ignore() {}).
        catch(function _ignore() {});
      }
    );

    EnigmailPEPMessageHist.isLatestMessage(headerData.from.headerValue, headerData.date.headerValue).
    then(function _result(latestMessage) {
      EnigmailLog.DEBUG("pEpAdapter.jsm: processInlinePGP: " + latestMessage + "\n");
      try {
        if (latestMessage) {
          var channel = EnigmailStreams.createChannel(msgUri.spec);
          channel.asyncOpen(stream, null);
        }
      }
      catch (e) {
        EnigmailLog.DEBUG("pEpAdapter.jsm: processInlinePGP: exception " + e.toString() + "\n");
      }
    }).catch(function _fail() {
      EnigmailLog.DEBUG("pEpAdapter.jsm: processInlinePGP: error\n");
    });
  },

  /**
   * prepare the relevant data for the Trustwords dialog
   *
   * @param emailAddress: String - the email address of the peer to verify
   * @param headerData:   either: Object - nsIMsgHdr object for the message
   *                                (to identify the ideal own identity)
   *                      or:     String - email address of own identity
   * @return Promise(object)
   */
  prepareTrustWordsDlg: function(emailAddress, headerData) {
    let deferred = Promise.defer();
    let emailId = null;
    let useOwnId = null;
    let emailIdRating = null;
    let useLocale = "en";
    let ownIds = [];
    let supportedLocale = [];

    let uiLocale = EnigmailLocale.getUILocale().substr(0, 2).toLowerCase();

    emailAddress = emailAddress.toLowerCase();

    let allEmails = "";

    if (typeof(headerData) === "string") {
      allEmails = headerData;
    }
    else {
      if ("from" in headerData) {
        allEmails += headerData.from.headerValue + ",";
      }
      if ("to" in headerData) {
        allEmails += headerData.to.headerValue + ",";
      }
      if ("cc" in headerData) {
        allEmails += headerData.cc.headerValue + ",";
      }
    }

    let emailsInMessage = EnigmailFuncs.stripEmail(allEmails.toLowerCase()).split(/,/);

    EnigmailPEPAdapter.pep.getOwnIdentities().then(function _gotOwnIds(data) {
      if (("result" in data) && typeof data.result.outParams[0] === "object" && Array.isArray(data.result.outParams[0])) {
        ownIds = data.result.outParams[0];
      }

      for (let i = 0; i < ownIds.length; i++) {
        if (ownIds[i].address.toLowerCase() === emailAddress) {
          deferred.reject("cannotVerifyOwnId");
        }

        useOwnId = ownIds[0];
        for (let j = 0; j < emailsInMessage.length; j++) {
          if (ownIds[i].address.toLowerCase() === emailsInMessage[j]) {
            useOwnId = ownIds[i];
            break;
          }
        }
      }

      return EnigmailPEPAdapter.getIdentityForEmail(emailAddress);
    }).then(function _gotIdentityForEmail(data) {
      if (("result" in data) && typeof data.result === "object" && typeof data.result.outParams[0] === "object") {
        emailId = data.result.outParams[0];
      }
      else {
        deferred.reject("cannotFindKey");
      }

      return EnigmailPEPAdapter.pep.getIdentityRating(emailId);

    }).then(function _gotIdentityRating(data) {
      if ("result" in data && Array.isArray(data.result.outParams) && typeof(data.result.outParams[0]) === "object" &&
        "rating" in data.result.outParams[0]) {
        emailIdRating = data.result.outParams[0];
      }

      return EnigmailPEPAdapter.getSupportedLanguages();
    }).then(function _gotLocale(localeList) {
      supportedLocale = localeList;

      for (let i = 0; i < localeList.length; i++) {
        if (localeList[i].short === uiLocale) {
          useLocale = localeList[i].short;
        }
      }

      return EnigmailPEPAdapter.getTrustWordsForLocale(useOwnId, emailId, useLocale, false);
    }).then(function _gotTrustWords(data) {
      if (("result" in data) && typeof data.result === "object" && typeof data.result.outParams[1] === "string") {
        let trustWords = data.result.outParams[1];
        deferred.resolve({
          ownId: useOwnId,
          otherId: emailId,
          userRating: emailIdRating,
          locale: useLocale,
          supportedLocale: supportedLocale,
          trustWords: trustWords,
          dialogMode: 0
        });
      }
      else {
        deferred.reject("generalFailure");
      }
    }).catch(function _err(errorMsg) {
      deferred.reject(errorMsg);
    });

    return deferred.promise;
  },

  /**
   * Get the trustwords for a pair of pEpPerson's and a given language
   *
   * @param ownId:   Object - pEpPerson object of own id
   * @param otherId: Object - pEpPerson object of other person's identity
   *
   * @return Promise(data)
   */
  getTrustWordsForLocale: function(ownId, otherId, language, longWords) {

    return EnigmailPEPAdapter.pep.getTrustWords(ownId, otherId, language, longWords);
  },

  resetTrustForEmail: function(emailAddr) {
    let deferred = Promise.defer();

    EnigmailPEPAdapter.getIdentityForEmail(emailAddr).
    then(function _gotIdentityForEmail(data) {
      if (("result" in data) && typeof data.result === "object" && typeof data.result.outParams[0] === "object") {
        let emailId = data.result.outParams[0];
        EnigmailPEPAdapter.pep.resetIdentityTrust(emailId).then(
          function _ok() {
            deferred.resolve();
          }
        ).catch(function _err() {
          deferred.resolve();
        });
      }
    });

    return deferred.promise;
  },

  getRatingsForEmails: function(emailArr) {
    EnigmailLog.DEBUG("pEpAdapter.getRatingsForEmails(" + emailArr.length + ")\n");

    let deferred = Promise.defer();
    let identities = [];

    function getNextIdentity(emailNum) {
      if (emailNum >= emailArr.length) {
        EnigmailLog.DEBUG("pEpAdapter.getRatingsForEmails: done\n");
        deferred.resolve(identities);
        return;
      }

      if (emailArr[emailNum].indexOf("@") < 0) {
        // skip if not an email address
        getNextIdentity(emailNum + 1);
        return;
      }

      let identity = null;
      let rating = 3; // default rating: no key available

      EnigmailPEPAdapter.getIdentityForEmail(emailArr[emailNum]).then(
        function _gotIdentity(data) {
          if (data && ("result" in data) && typeof data.result === "object" && typeof data.result.outParams[0] === "object") {
            identity = data.result.outParams[0];
            return EnigmailPEPAdapter.pep.getIdentityRating(identity);
          }
          else {
            let deferred = Promise.defer();
            deferred.resolve({
              status: 0
            });
            return deferred.promise;
          }
        }).then(
        function _gotRating(data) {
          if ("result" in data && Array.isArray(data.result.outParams) && typeof(data.result.outParams[0]) === "object" &&
            "rating" in data.result.outParams[0]) {
            rating = data.result.outParams[0].rating;
          }

          identities.push({
            email: emailArr[emailNum],
            user_id: identity,
            rating: rating
          });
          getNextIdentity(emailNum + 1);
        }).catch(
        function _err(data) {
          EnigmailLog.DEBUG("pEpAdapter.getIdentitiesForEmails: ERROR: " + JSON.stringify(data) + "\n");
          deferred.reject(data);
        });
    }

    getNextIdentity(0);
    return deferred.promise;
  },

  calculateColorFromRating: function(rating) {
    let color = "grey";
    if (rating === -2 || rating === 2) {
      color = "grey";
    }
    else if (rating < 0) {
      color = "red";
    }
    else if (rating < 6) {
      color = "grey";
    }
    else if (rating >= 7) {
      color = "green";
    }
    else {
      color = "yellow";
    }

    return color;
  },

  /**
   * Get CSS class for pEp rating
   */
  getRatingClass: function(rating) {
    let setClass = "";
    let color = this.calculateColorFromRating(rating);

    switch (color) {
      case "grey":
        setClass = "enigmailPepIdentityUnknown";
        break;
      case "red":
        setClass = "enigmailPepIdentityMistrust";
        break;
      case "yellow":
        setClass = "enigmailPepIdentityReliable";
        break;
      case "green":
        setClass = "enigmailPepIdentityTrusted";
    }

    return setClass;
  },

  getRatingLabel: function(ratingNum) {
    let ratingDesc = "Undefined";

    switch (ratingNum) {
      case 1:
        ratingDesc = "CannotDecrypt";
        break;
      case 2:
        ratingDesc = "HaveNoKey";
        break;
      case 3:
        ratingDesc = "Unencrypted";
        break;
      case 4:
        ratingDesc = "UnencryptedForSome";
        break;
      case 5:
        ratingDesc = "Unreliable";
        break;
      case 6:
        ratingDesc = "Reliable";
        break;
      case 7:
      case 8:
      case 9:
        ratingDesc = "Trusted";
        break;
      case -2:
        ratingDesc = "Broken";
        break;
      case -1:
        ratingDesc = "Mistrust";
        break;
      case -3:
        ratingDesc = "UnderAttack";
        break;
    }

    return ratingDesc;
  }
};