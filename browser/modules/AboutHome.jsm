/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var Cc = Components.classes;
var Ci = Components.interfaces;
var Cu = Components.utils;

this.EXPORTED_SYMBOLS = [ "AboutHomeUtils", "AboutHome" ];

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "AppConstants",
  "resource://gre/modules/AppConstants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "AutoMigrate",
  "resource:///modules/AutoMigrate.jsm");
/*XPCOMUtils.defineLazyModuleGetter(this, "fxAccounts",
  "resource://gre/modules/FxAccounts.jsm");*/
XPCOMUtils.defineLazyModuleGetter(this, "PrivateBrowsingUtils",
  "resource://gre/modules/PrivateBrowsingUtils.jsm");

this.AboutHomeUtils = {

  get showKnowYourRights() {
    return false;
  }
};

/**
 * This code provides services to the about:home page. Whenever
 * about:home needs to do something chrome-privileged, it sends a
 * message that's handled here.
 */
var AboutHome = {
  MESSAGES: [
    "AboutHome:RestorePreviousSession",
    "AboutHome:Downloads",
    "AboutHome:Bookmarks",
    "AboutHome:History",
    "AboutHome:Addons",
    "AboutHome:Sync",
    "AboutHome:Settings",
  ],

  init() {
    for (let msg of this.MESSAGES) {
      Services.mm.addMessageListener(msg, this);
    }
  },

  // Additional listeners are registered in nsBrowserGlue.js
  receiveMessage(aMessage) {
    let window = aMessage.target.ownerGlobal;

    switch (aMessage.name) {
      case "AboutHome:RestorePreviousSession":
        let ss = Cc["@mozilla.org/browser/sessionstore;1"].
                 getService(Ci.nsISessionStore);
        if (ss.canRestoreLastSession) {
          ss.restoreLastSession();
        }
        break;

      case "AboutHome:Downloads":
        window.BrowserDownloadsUI();
        break;

      case "AboutHome:Bookmarks":
        window.PlacesCommandHook.showPlacesOrganizer("UnfiledBookmarks");
        break;

      case "AboutHome:History":
        window.PlacesCommandHook.showPlacesOrganizer("History");
        break;

      case "AboutHome:Addons":
        window.BrowserOpenAddonsMgr();
        break;

      case "AboutHome:Sync":
        window.openPreferences("paneSync", { urlParams: { entrypoint: "abouthome" }, origin: "aboutHome"  });
        break;

      case "AboutHome:Settings":
        window.openPreferences(undefined, {origin: "aboutHome"} );
        break;

      case "AboutHome:RequestUpdate":
        this.sendAboutHomeData(aMessage.target);
        break;

      case "AboutHome:MaybeShowMigrateMessage":
        AutoMigrate.shouldShowMigratePrompt(aMessage.target).then((prompt) => {
          if (prompt) {
            AutoMigrate.showUndoNotificationBar(aMessage.target);
          }
        });
        break;
    }
  },

  // Send all the chrome-privileged data needed by about:home. This
  // gets re-sent when the search engine changes.
  sendAboutHomeData(target) {
    let wrapper = {};
    Components.utils.import("resource:///modules/sessionstore/SessionStore.jsm",
      wrapper);
    let ss = wrapper.SessionStore;

    ss.promiseInitialized.then(function() {
      let data = {
        showRestoreLastSession: ss.canRestoreLastSession,
        showKnowYourRights: AboutHomeUtils.showKnowYourRights,
      };

      if (target && target.messageManager) {
        target.messageManager.sendAsyncMessage("AboutHome:Update", data);
      } else {
        let mm = Cc["@mozilla.org/globalmessagemanager;1"].getService(Ci.nsIMessageListenerManager);
        mm.broadcastAsyncMessage("AboutHome:Update", data);
      }
    }).catch(function onError(x) {
      Cu.reportError("Error in AboutHome.sendAboutHomeData: " + x);
    });
  },

};
