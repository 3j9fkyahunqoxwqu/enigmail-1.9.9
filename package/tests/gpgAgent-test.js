/*global do_load_module: false, do_get_file: false, do_get_cwd: false, testing: false, test: false, Assert: false, resetting: false, JSUnit: false, do_test_pending: false, do_test_finished: false */
/*global TestHelper: false, withEnvironment: false, nsIWindowsRegKey: true */
/*jshint -W097 */
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

"use strict";

do_load_module("file://" + do_get_cwd().path + "/testHelper.js"); /*global TestHelper: false, withEnvironment: false, withEnigmail: false, component: false */

testing("gpgAgent.jsm"); /*global EnigmailGpgAgent: false, EnigmailOS: false */
component("enigmail/prefs.jsm"); /*global EnigmailPrefs: false */
component("enigmail/gpg.jsm"); /*global EnigmailGpg: false */

// testing: determineGpgHomeDir
//   environment: GNUPGHOME
//   isWin32:
//     registry Software\GNU\GNUPG\HomeDir
//     environment: USERPROFILE + \Application Data\GnuPG
//     environment: SystemRoot + \Application Data\GnuPG
//     c:\gnupg
//   environment: HOME + .gnupg

test(function determineGpgHomeDirReturnsGNUPGHOMEIfExists() {
    withEnvironment({"GNUPGHOME": "stuffResult1"}, function(e) {
        var enigmail = {environment: e};
        Assert.equal("stuffResult1", EnigmailGpgAgent.determineGpgHomeDir(enigmail));
    });
});

test(function determineGpgHomeDirReturnsHomePlusGnupgForNonWindowsIfNoGNUPGHOMESpecificed() {
    withEnvironment({"HOME": "/my/little/home"}, function(e) {
        e.set("GNUPGHOME",null);
        var enigmail = {environment: e};
        Assert.equal("/my/little/home/.gnupg", EnigmailGpgAgent.determineGpgHomeDir(enigmail));
    });
});

test(function determineGpgHomeDirReturnsRegistryValueForWindowsIfExists() {
    withEnvironment({}, function(e) {
        e.set("GNUPGHOME",null);
        resetting(EnigmailOS, 'getWinRegistryString', function(a, b, c) {
            if(a === "Software\\GNU\\GNUPG" && b === "HomeDir" && c === "foo bar") {
                return "\\foo\\bar\\gnupg";
            } else {
                return "\\somewhere\\else";
            }
        }, function() {
            resetting(EnigmailOS, 'isWin32', true, function() {
                var enigmail = {environment: e};
                nsIWindowsRegKey = {ROOT_KEY_CURRENT_USER: "foo bar"};
                Assert.equal("\\foo\\bar\\gnupg", EnigmailGpgAgent.determineGpgHomeDir(enigmail));
            });
        });
    });
});

test(function determineGpgHomeDirReturnsUserprofileIfItExists() {
    withEnvironment({"USERPROFILE": "\\bahamas"}, function(e) {
        e.set("GNUPGHOME",null);
        resetting(EnigmailOS, 'getWinRegistryString', function(a, b, c) {}, function() {
            resetting(EnigmailOS, 'isWin32', true, function() {
                var enigmail = {environment: e};
                nsIWindowsRegKey = {ROOT_KEY_CURRENT_USER: "foo bar"};
                Assert.equal("\\bahamas\\Application Data\\GnuPG", EnigmailGpgAgent.determineGpgHomeDir(enigmail));
            });
        });
    });
});

test(function determineGpgHomeDirReturnsSystemrootIfItExists() {
    withEnvironment({"SystemRoot": "\\tahiti"}, function(e) {
        e.set("GNUPGHOME",null);
        resetting(EnigmailOS, 'getWinRegistryString', function(a, b, c) {}, function() {
            resetting(EnigmailOS, 'isWin32', true, function() {
                var enigmail = {environment: e};
                nsIWindowsRegKey = {ROOT_KEY_CURRENT_USER: "foo bar"};
                Assert.equal("\\tahiti\\Application Data\\GnuPG", EnigmailGpgAgent.determineGpgHomeDir(enigmail));
            });
        });
    });
});

test(function determineGpgHomeDirReturnsDefaultForWin32() {
    withEnvironment({}, function(e) {
        e.set("GNUPGHOME",null);
        resetting(EnigmailOS, 'getWinRegistryString', function(a, b, c) {}, function() {
            resetting(EnigmailOS, 'isWin32', true, function() {
                var enigmail = {environment: e};
                nsIWindowsRegKey = {ROOT_KEY_CURRENT_USER: "foo bar"};
                Assert.equal("C:\\gnupg", EnigmailGpgAgent.determineGpgHomeDir(enigmail));
            });
        });
    });
});


// // testing: useGpgAgent
// // useGpgAgent depends on several values:
// //   EnigmailOS.isDosLike()
// //   Gpg.getGpgFeature("supports-gpg-agent")
// //   Gpg.getGpgFeature("autostart-gpg-agent")
// //   EnigmailGpgAgent.gpgAgentInfo.envStr.length>0
// //   EnigmailPrefs.getPrefBranch().getBoolPref("useGpgAgent")

function asDosLike(f) {
    resetting(EnigmailOS, 'isDosLikeVal', true, f);
}

function notDosLike(f) {
    resetting(EnigmailOS, 'isDosLikeVal', false, f);
}

function withGpgFeatures(features, f) {
    resetting(EnigmailGpg, 'getGpgFeature', function(feature) {
        return features.indexOf(feature) != -1;
    }, f);
}

function mockPrefs(prefs) {
    return {
        getBoolPref: function(name) { return prefs[name]; }
    };
}

test(function useGpgAgentIsFalseIfIsDosLikeAndDoesntSupportAgent() {
    asDosLike(function() {
        withGpgFeatures([], function() {
            Assert.ok(!EnigmailGpgAgent.useGpgAgent());
        });
    });
});

test(function useGpgAgentIsTrueIfIsDosLikeAndSupportsAgentAndAutostartsAgent() {
    asDosLike(function() {
        withGpgFeatures(["supports-gpg-agent", "autostart-gpg-agent"], function() {
            Assert.ok(EnigmailGpgAgent.useGpgAgent());
        });
    });
});

test(function useGpgAgentIsTrueIfIsDosLikeAndSupportsAgentAndThereExistsAnAgentString() {
    asDosLike(function() {
        withGpgFeatures(["supports-gpg-agent"], function() {
            EnigmailGpgAgent.gpgAgentInfo.envStr = "blarg";
            Assert.ok(EnigmailGpgAgent.useGpgAgent());
        });
    });
});

test(function useGpgAgentIsFalseIfIsDosLikeAndSupportsAgentButNoAgentInfoAvailable() {
    asDosLike(function() {
        withGpgFeatures(["supports-gpg-agent"], function() {
                EnigmailGpgAgent.gpgAgentInfo.envStr = "";
                Assert.ok(!EnigmailGpgAgent.useGpgAgent());
        });
    });
});

test(function useGpgAgentIsTrueIfIsDosLikeAndSupportsAgentAndPrefIsSet() {
    asDosLike(function() {
        withGpgFeatures(["supports-gpg-agent"], function() {
            resetting(EnigmailPrefs, 'getPrefBranch', function() { return mockPrefs({useGpgAgent: true}); }, function() {
                Assert.ok(EnigmailGpgAgent.useGpgAgent());
            });
        });
    });
});


test(function useGpgAgentIsTrueIfNotDosLikeAndSupportsAgentAndAutostartsAgent() {
    notDosLike(function() {
        withGpgFeatures(["supports-gpg-agent", "autostart-gpg-agent"], function() {
            Assert.ok(EnigmailGpgAgent.useGpgAgent());
        });
    });
});

test(function useGpgAgentIsTrueIfNotDosLikeAndSupportsAgentAndThereExistsAnAgentString() {
    notDosLike(function() {
        withGpgFeatures(["supports-gpg-agent"], function() {
            EnigmailGpgAgent.gpgAgentInfo.envStr = "blarg";
            Assert.ok(EnigmailGpgAgent.useGpgAgent());
        });
    });
});

test(function useGpgAgentIsFalseIfNotDosLikeAndSupportsAgentButNoAgentInfoAvailable() {
    notDosLike(function() {
        withGpgFeatures(["supports-gpg-agent"], function() {
            EnigmailGpgAgent.gpgAgentInfo.envStr = "";
            Assert.ok(!EnigmailGpgAgent.useGpgAgent());
        });
    });
});

test(function useGpgAgentIsTrueIfNotDosLikeAndSupportsAgentAndPrefIsSet() {
    notDosLike(function() {
        withGpgFeatures(["supports-gpg-agent"], function() {
            resetting(EnigmailPrefs, 'getPrefBranch', function() { return mockPrefs({useGpgAgent: true}); }, function() {
                Assert.ok(EnigmailGpgAgent.useGpgAgent());
            });
        });
    });
});

// // setAgentPath

test(withEnigmail(function setAgentPathDefaultValues(enigmail) {
    withEnvironment({}, function(e) {
            enigmail.environment = e;
            EnigmailGpgAgent.setAgentPath(JSUnit.createStubWindow(), enigmail);
            Assert.equal("gpg", EnigmailGpgAgent.agentType);
            Assert.equal("/usr/bin/gpg2", EnigmailGpgAgent.agentPath.path);
            //        Assert.equal("2.0.22", Gpg.agentVersion); // this will vary between environments.
            Assert.equal("/usr/bin/gpgconf", EnigmailGpgAgent.gpgconfPath.path);
            Assert.equal("/usr/bin/gpg-connect-agent", EnigmailGpgAgent.connGpgAgentPath.path);
    });
}));

// // resolveToolPath

test(withEnigmail(function resolveToolPathDefaultValues(enigmail) {
    withEnvironment({}, function(e) {
        resetting(EnigmailGpgAgent, 'agentPath', "/usr/bin/gpg-agent", function() {
            enigmail.environment = e;
            var result = EnigmailGpgAgent.resolveToolPath("zip");
            Assert.equal("/usr/bin/zip", result.path);
        });
    });
}));

test(withEnigmail(function resolveToolPathFromPATH(enigmail) {
    withEnvironment({PATH: "/sbin"}, function(e) {
        resetting(EnigmailGpgAgent, 'agentPath', "/usr/bin/gpg-agent", function() {
            enigmail.environment = e;
            var result = EnigmailGpgAgent.resolveToolPath("route");
            Assert.equal("/sbin/route", result.path);
        });
    });
}));

// detectGpgAgent
test(withEnigmail(function detectGpgAgentSetsAgentInfoFromEnvironmentVariable(enigmail) {
    withEnvironment({GPG_AGENT_INFO: "a happy agent"}, function(e) {
        enigmail.environment = e;
        EnigmailGpgAgent.detectGpgAgent(JSUnit.createStubWindow(), enigmail);

        Assert.ok(EnigmailGpgAgent.gpgAgentInfo.preStarted);
        Assert.equal("a happy agent", EnigmailGpgAgent.gpgAgentInfo.envStr);
        Assert.ok(!EnigmailGpgAgent.gpgAgentIsOptional);
    });
}));

test(withEnigmail(function detectGpgAgentWithNoAgentInfoInEnvironment(enigmail) {
    withEnvironment({}, function(e) {
        enigmail.environment = e;
        EnigmailGpgAgent.detectGpgAgent(JSUnit.createStubWindow(), enigmail);

        Assert.ok(!EnigmailGpgAgent.gpgAgentInfo.preStarted);
        Assert.ok(!EnigmailGpgAgent.gpgAgentIsOptional);
    });
}));

test(withEnigmail(function detectGpgAgentWithAutostartFeatureWillDoNothing(enigmail) {
    withEnvironment({}, function(e) {
        withGpgFeatures(["autostart-gpg-agent"], function() {
            enigmail.environment = e;
            EnigmailGpgAgent.detectGpgAgent(JSUnit.createStubWindow(), enigmail);
            Assert.equal("none", EnigmailGpgAgent.gpgAgentInfo.envStr);
        });
    });
}));