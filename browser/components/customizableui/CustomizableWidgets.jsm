/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";
const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

this.EXPORTED_SYMBOLS = ["CustomizableWidgets"];

Cu.import("resource:///modules/CustomizableUI.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/AppConstants.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PlacesUtils",
  "resource://gre/modules/PlacesUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PlacesUIUtils",
  "resource:///modules/PlacesUIUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "RecentlyClosedTabsAndWindowsMenuUtils",
  "resource:///modules/sessionstore/RecentlyClosedTabsAndWindowsMenuUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "ShortcutUtils",
  "resource://gre/modules/ShortcutUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "CharsetMenu",
  "resource://gre/modules/CharsetMenu.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PrivateBrowsingUtils",
  "resource://gre/modules/PrivateBrowsingUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SyncedTabs",
  "resource://services-sync/SyncedTabs.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "ContextualIdentityService",
  "resource://gre/modules/ContextualIdentityService.jsm");

XPCOMUtils.defineLazyGetter(this, "CharsetBundle", function() {
  const kCharsetBundle = "chrome://global/locale/charsetMenu.properties";
  return Services.strings.createBundle(kCharsetBundle);
});
XPCOMUtils.defineLazyGetter(this, "BrandBundle", function() {
  const kBrandBundle = "chrome://branding/locale/brand.properties";
  return Services.strings.createBundle(kBrandBundle);
});

const kNSXUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const kPrefCustomizationDebug = "browser.uiCustomization.debug";
const kWidePanelItemClass = "panel-wide-item";

XPCOMUtils.defineLazyGetter(this, "log", () => {
  let scope = {};
  Cu.import("resource://gre/modules/Console.jsm", scope);
  let debug = Services.prefs.getBoolPref(kPrefCustomizationDebug, false);
  let consoleOptions = {
    maxLogLevel: debug ? "all" : "log",
    prefix: "CustomizableWidgets",
  };
  return new scope.ConsoleAPI(consoleOptions);
});



function setAttributes(aNode, aAttrs) {
  let doc = aNode.ownerDocument;
  for (let [name, value] of Object.entries(aAttrs)) {
    if (!value) {
      if (aNode.hasAttribute(name))
        aNode.removeAttribute(name);
    } else {
      if (name == "shortcutId") {
        continue;
      }
      if (name == "label" || name == "tooltiptext") {
        let stringId = (typeof value == "string") ? value : name;
        let additionalArgs = [];
        if (aAttrs.shortcutId) {
          let shortcut = doc.getElementById(aAttrs.shortcutId);
          if (shortcut) {
            additionalArgs.push(ShortcutUtils.prettifyShortcut(shortcut));
          }
        }
        value = CustomizableUI.getLocalizedProperty({id: aAttrs.id}, stringId, additionalArgs);
      }
      aNode.setAttribute(name, value);
    }
  }
}

function updateCombinedWidgetStyle(aNode, aArea, aModifyCloseMenu) {
  let inPanel = (aArea == CustomizableUI.AREA_PANEL);
  let cls = inPanel ? "panel-combined-button" : "toolbarbutton-1 toolbarbutton-combined";
  let attrs = {class: cls};
  if (aModifyCloseMenu) {
    attrs.closemenu = inPanel ? "none" : null;
  }
  for (let i = 0, l = aNode.childNodes.length; i < l; ++i) {
    if (aNode.childNodes[i].localName == "separator")
      continue;
    setAttributes(aNode.childNodes[i], attrs);
  }
}

function fillSubviewFromMenuItems(aMenuItems, aSubview) {
  let attrs = ["oncommand", "onclick", "label", "key", "disabled",
               "command", "observes", "hidden", "class", "origin",
               "image", "checked", "style"];

  let doc = aSubview.ownerDocument;
  let fragment = doc.createDocumentFragment();
  for (let menuChild of aMenuItems) {
    if (menuChild.hidden)
      continue;

    let subviewItem;
    if (menuChild.localName == "menuseparator") {
      // Don't insert duplicate or leading separators. This can happen if there are
      // menus (which we don't copy) above the separator.
      if (!fragment.lastChild || fragment.lastChild.localName == "menuseparator") {
        continue;
      }
      subviewItem = doc.createElementNS(kNSXUL, "menuseparator");
    } else if (menuChild.localName == "menuitem") {
      subviewItem = doc.createElementNS(kNSXUL, "toolbarbutton");
      CustomizableUI.addShortcut(menuChild, subviewItem);

      let item = menuChild;
      if (!item.hasAttribute("onclick")) {
        subviewItem.addEventListener("click", event => {
          let newEvent = new doc.defaultView.MouseEvent(event.type, event);
          item.dispatchEvent(newEvent);
        });
      }

      if (!item.hasAttribute("oncommand")) {
        subviewItem.addEventListener("command", event => {
          let newEvent = doc.createEvent("XULCommandEvent");
          newEvent.initCommandEvent(
            event.type, event.bubbles, event.cancelable, event.view,
            event.detail, event.ctrlKey, event.altKey, event.shiftKey,
            event.metaKey, event.sourceEvent, 0);
          item.dispatchEvent(newEvent);
        });
      }
    } else {
      continue;
    }
    for (let attr of attrs) {
      let attrVal = menuChild.getAttribute(attr);
      if (attrVal)
        subviewItem.setAttribute(attr, attrVal);
    }
    // We do this after so the .subviewbutton class doesn't get overriden.
    if (menuChild.localName == "menuitem") {
      subviewItem.classList.add("subviewbutton");
    }
    fragment.appendChild(subviewItem);
  }
  aSubview.appendChild(fragment);
}

function clearSubview(aSubview) {
  let parent = aSubview.parentNode;
  // We'll take the container out of the document before cleaning it out
  // to avoid reflowing each time we remove something.
  parent.removeChild(aSubview);

  while (aSubview.firstChild) {
    aSubview.firstChild.remove();
  }

  parent.appendChild(aSubview);
}

const CustomizableWidgets = [
  {
    id: "history-panelmenu",
    type: "view",
    viewId: "PanelUI-history",
    shortcutId: "key_gotoHistory",
    tooltiptext: "history-panelmenu.tooltiptext2",
    defaultArea: CustomizableUI.AREA_PANEL,
    recentlyClosedTabsPanel: "appMenu-library-recentlyClosedTabs",
    recentlyClosedWindowsPanel: "appMenu-library-recentlyClosedWindows",
    handleEvent(event) {
      switch (event.type) {
        case "PanelMultiViewHidden":
          this.onPanelMultiViewHidden(event);
          break;
        case "ViewShowing":
          this.onSubViewShowing(event);
          break;
        default:
          throw new Error(`Unsupported event for '${this.id}'`);
      }
    },
    onViewShowing(aEvent) {
      // Populate our list of history
      const kMaxResults = 15;
      let doc = aEvent.target.ownerDocument;
      let win = doc.defaultView;

      if (AppConstants.MOZ_PHOTON_THEME && win.gPhotonStructure) {
        // For the Photon panelview we're going to do something different!
        this.onPhotonViewShowing(aEvent);
        return;
      }

      let options = PlacesUtils.history.getNewQueryOptions();
      options.excludeQueries = true;
      options.queryType = options.QUERY_TYPE_HISTORY;
      options.sortingMode = options.SORT_BY_DATE_DESCENDING;
      options.maxResults = kMaxResults;
      let query = PlacesUtils.history.getNewQuery();

      let items = doc.getElementById("PanelUI-historyItems");
      // Clear previous history items.
      while (items.firstChild) {
        items.firstChild.remove();
      }

      // Get all statically placed buttons to supply them with keyboard shortcuts.
      let staticButtons = items.parentNode.getElementsByTagNameNS(kNSXUL, "toolbarbutton");
      for (let i = 0, l = staticButtons.length; i < l; ++i)
        CustomizableUI.addShortcut(staticButtons[i]);

      aEvent.detail.addBlocker(new Promise((resolve, reject) => {
        PlacesUtils.history.QueryInterface(Ci.nsPIPlacesDatabase)
                           .asyncExecuteLegacyQueries([query], 1, options, {
          handleResult(aResultSet) {
            let onItemCommand = function(aItemCommandEvent) {
              // Only handle the click event for middle clicks, we're using the command
              // event otherwise.
              if (aItemCommandEvent.type == "click" &&
                  aItemCommandEvent.button != 1) {
                return;
              }
              let item = aItemCommandEvent.target;
              win.openUILink(item.getAttribute("targetURI"), aItemCommandEvent);
              CustomizableUI.hidePanelForNode(item);
            };
            let fragment = doc.createDocumentFragment();
            let row;
            while ((row = aResultSet.getNextRow())) {
              let uri = row.getResultByIndex(1);
              let title = row.getResultByIndex(2);

              let item = doc.createElementNS(kNSXUL, "toolbarbutton");
              item.setAttribute("label", title || uri);
              item.setAttribute("targetURI", uri);
              item.setAttribute("class", "subviewbutton");
              item.addEventListener("command", onItemCommand);
              item.addEventListener("click", onItemCommand);
              item.setAttribute("image", "page-icon:" + uri);
              fragment.appendChild(item);
            }
            items.appendChild(fragment);
          },
          handleError(aError) {
            log.debug("History view tried to show but had an error: " + aError);
            reject();
          },
          handleCompletion(aReason) {
            log.debug("History view is being shown!");
            resolve();
          },
        });
      }));

      let recentlyClosedTabs = doc.getElementById("PanelUI-recentlyClosedTabs");
      while (recentlyClosedTabs.firstChild) {
        recentlyClosedTabs.firstChild.remove();
      }

      let recentlyClosedWindows = doc.getElementById("PanelUI-recentlyClosedWindows");
      while (recentlyClosedWindows.firstChild) {
        recentlyClosedWindows.firstChild.remove();
      }

      let utils = RecentlyClosedTabsAndWindowsMenuUtils;
      let tabsFragment = utils.getTabsFragment(doc.defaultView, "toolbarbutton", true,
                                               "menuRestoreAllTabsSubview.label");
      let separator = doc.getElementById("PanelUI-recentlyClosedTabs-separator");
      let elementCount = tabsFragment.childElementCount;
      separator.hidden = !elementCount;
      while (--elementCount >= 0) {
        let element = tabsFragment.children[elementCount];
        CustomizableUI.addShortcut(element);
        element.classList.add("subviewbutton", "cui-withicon");
      }
      recentlyClosedTabs.appendChild(tabsFragment);

      let windowsFragment = utils.getWindowsFragment(doc.defaultView, "toolbarbutton", true,
                                                     "menuRestoreAllWindowsSubview.label");
      separator = doc.getElementById("PanelUI-recentlyClosedWindows-separator");
      elementCount = windowsFragment.childElementCount;
      separator.hidden = !elementCount;
      while (--elementCount >= 0) {
        let element = windowsFragment.children[elementCount];
        CustomizableUI.addShortcut(element);
        element.classList.add("subviewbutton", "cui-withicon");
      }
      recentlyClosedWindows.appendChild(windowsFragment);
    },
    onPhotonViewShowing(event) {
      if (this._panelMenuView)
        return;

      let panelview = event.target;
      let document = panelview.ownerDocument;
      let window = document.defaultView;

      // We restrict the amount of results to 42. Not 50, but 42. Why? Because 42.
      let query = "place:queryType=" + Ci.nsINavHistoryQueryOptions.QUERY_TYPE_HISTORY +
        "&sort=" + Ci.nsINavHistoryQueryOptions.SORT_BY_DATE_DESCENDING +
        "&maxResults=42&excludeQueries=1";
      this._panelMenuView = new window.PlacesPanelview(document.getElementById("appMenu_historyMenu"),
        panelview, query);
      // When either of these sub-subviews show, populate them with recently closed
      // objects data.
      document.getElementById(this.recentlyClosedTabsPanel).addEventListener("ViewShowing", this);
      document.getElementById(this.recentlyClosedWindowsPanel).addEventListener("ViewShowing", this);
      // When the popup is hidden (thus the panelmultiview node as well), make
      // sure to stop listening to PlacesDatabase updates.
      panelview.panelMultiView.addEventListener("PanelMultiViewHidden", this);
    },
    onCreated(aNode) {
      // Skip this for the Photon panelview.
      let doc = aNode.ownerDocument;
      if (AppConstants.MOZ_PHOTON_THEME && doc.defaultView.gPhotonStructure)
        return;

      // Middle clicking recently closed items won't close the panel - cope:
      let onRecentlyClosedClick = function(aEvent) {
        if (aEvent.button == 1) {
          CustomizableUI.hidePanelForNode(this);
        }
      };
      let recentlyClosedTabs = doc.getElementById("PanelUI-recentlyClosedTabs");
      let recentlyClosedWindows = doc.getElementById("PanelUI-recentlyClosedWindows");
      recentlyClosedTabs.addEventListener("click", onRecentlyClosedClick);
      recentlyClosedWindows.addEventListener("click", onRecentlyClosedClick);
    },
    onViewHiding(aEvent) {
      log.debug("History view is being hidden!");
    },
    onPanelMultiViewHidden(event) {
      let panelMultiView = event.target;
      let document = panelMultiView.ownerDocument;
      if (this._panelMenuView) {
        this._panelMenuView.uninit();
        delete this._panelMenuView;
        document.getElementById(this.recentlyClosedTabsPanel).removeEventListener("ViewShowing", this);
        document.getElementById(this.recentlyClosedWindowsPanel).removeEventListener("ViewShowing", this);
      }
      panelMultiView.removeEventListener("PanelMultiViewHidden", this);
    },
    onSubViewShowing(event) {
      let panelview = event.target;
      let document = event.target.ownerDocument;
      let window = document.defaultView;
      let viewType = panelview.id == this.recentlyClosedTabsPanel ? "Tabs" : "Windows";

      this._panelMenuView.clearAllContents(panelview);

      let utils = RecentlyClosedTabsAndWindowsMenuUtils;
      let method = `get${viewType}Fragment`;
      let fragment = utils[method](window, "toolbarbutton");
      let elementCount = fragment.childElementCount;
      this._panelMenuView._setEmptyPopupStatus(panelview, !elementCount);
      if (!elementCount)
        return;

      let body = document.createElement("vbox");
      body.className = "panel-subview-body";
      body.appendChild(fragment);
      let footer;
      while (--elementCount >= 0) {
        let element = body.childNodes[elementCount];
        CustomizableUI.addShortcut(element);
        element.classList.add("subviewbutton");
        if (element.classList.contains("restoreallitem")) {
          footer = element;
          element.classList.add("panel-subview-footer");
        } else {
          element.classList.add("subviewbutton-iconic", "bookmark-item");
        }
      }
      panelview.appendChild(body);
      panelview.appendChild(footer);
    }
  }, {
    id: "privatebrowsing-button",
    shortcutId: "key_privatebrowsing",
    defaultArea: CustomizableUI.AREA_PANEL,
    onCommand(e) {
      let win = e.target.ownerGlobal;
      win.OpenBrowserWindow({private: true});
    }
  }, {
    id: "save-page-button",
    shortcutId: "key_savePage",
    tooltiptext: "save-page-button.tooltiptext3",
    defaultArea: CustomizableUI.AREA_PANEL,
    onCommand(aEvent) {
      let win = aEvent.target.ownerGlobal;
      win.saveBrowser(win.gBrowser.selectedBrowser);
    }
  }, {
    id: "find-button",
    shortcutId: "key_find",
    tooltiptext: "find-button.tooltiptext3",
    defaultArea: CustomizableUI.AREA_PANEL,
    onCommand(aEvent) {
      let win = aEvent.target.ownerGlobal;
      if (win.gFindBar) {
        win.gFindBar.onFindCommand();
      }
    }
  }, {
    id: "open-file-button",
    shortcutId: "openFileKb",
    tooltiptext: "open-file-button.tooltiptext3",
    defaultArea: CustomizableUI.AREA_PANEL,
    onCommand(aEvent) {
      let win = aEvent.target.ownerGlobal;
      win.BrowserOpenFileWindow();
    }
  }, {
    id: "sidebar-button",
    tooltiptext: "sidebar-button.tooltiptext2",
    onCommand(aEvent) {
      let win = aEvent.target.ownerGlobal;
      win.SidebarUI.toggle();
    },
    onCreated(aNode) {
      // Add an observer so the button is checked while the sidebar is open
      let doc = aNode.ownerDocument;
      let obChecked = doc.createElementNS(kNSXUL, "observes");
      obChecked.setAttribute("element", "sidebar-box");
      obChecked.setAttribute("attribute", "checked");
      let obPosition = doc.createElementNS(kNSXUL, "observes");
      obPosition.setAttribute("element", "sidebar-box");
      obPosition.setAttribute("attribute", "positionend");

      aNode.appendChild(obChecked);
      aNode.appendChild(obPosition);
    }
  }, {
    id: "add-ons-button",
    shortcutId: "key_openAddons",
    tooltiptext: "add-ons-button.tooltiptext3",
    defaultArea: CustomizableUI.AREA_PANEL,
    onCommand(aEvent) {
      let win = aEvent.target.ownerGlobal;
      win.BrowserOpenAddonsMgr();
    }
  }, {
    id: "zoom-controls",
    type: "custom",
    tooltiptext: "zoom-controls.tooltiptext2",
    defaultArea: CustomizableUI.AREA_PANEL,
    onBuild(aDocument) {
      let buttons = [{
        id: "zoom-out-button",
        command: "cmd_fullZoomReduce",
        label: true,
        tooltiptext: "tooltiptext2",
        shortcutId: "key_fullZoomReduce",
      }, {
        id: "zoom-reset-button",
        command: "cmd_fullZoomReset",
        tooltiptext: "tooltiptext2",
        shortcutId: "key_fullZoomReset",
      }, {
        id: "zoom-in-button",
        command: "cmd_fullZoomEnlarge",
        label: true,
        tooltiptext: "tooltiptext2",
        shortcutId: "key_fullZoomEnlarge",
      }];

      let node = aDocument.createElementNS(kNSXUL, "toolbaritem");
      node.setAttribute("id", "zoom-controls");
      node.setAttribute("label", CustomizableUI.getLocalizedProperty(this, "label"));
      node.setAttribute("title", CustomizableUI.getLocalizedProperty(this, "tooltiptext"));
      // Set this as an attribute in addition to the property to make sure we can style correctly.
      node.setAttribute("removable", "true");
      node.classList.add("chromeclass-toolbar-additional");
      node.classList.add("toolbaritem-combined-buttons");
      node.classList.add(kWidePanelItemClass);

      buttons.forEach(function(aButton, aIndex) {
        if (aIndex != 0)
          node.appendChild(aDocument.createElementNS(kNSXUL, "separator"));
        let btnNode = aDocument.createElementNS(kNSXUL, "toolbarbutton");
        setAttributes(btnNode, aButton);
        node.appendChild(btnNode);
      });

      updateCombinedWidgetStyle(node, this.currentArea, true);

      let listener = {
        onWidgetAdded: (aWidgetId, aArea, aPosition) => {
          if (aWidgetId != this.id)
            return;

          updateCombinedWidgetStyle(node, aArea, true);
        },

        onWidgetRemoved: (aWidgetId, aPrevArea) => {
          if (aWidgetId != this.id)
            return;

          // When a widget is demoted to the palette ('removed'), it's visual
          // style should change.
          updateCombinedWidgetStyle(node, null, true);
        },

        onWidgetReset: aWidgetNode => {
          if (aWidgetNode != node)
            return;
          updateCombinedWidgetStyle(node, this.currentArea, true);
        },

        onWidgetUndoMove: aWidgetNode => {
          if (aWidgetNode != node)
            return;
          updateCombinedWidgetStyle(node, this.currentArea, true);
        },

        onWidgetMoved: (aWidgetId, aArea) => {
          if (aWidgetId != this.id)
            return;
          updateCombinedWidgetStyle(node, aArea, true);
        },

        onWidgetInstanceRemoved: (aWidgetId, aDoc) => {
          if (aWidgetId != this.id || aDoc != aDocument)
            return;

          CustomizableUI.removeListener(listener);
        },

        onWidgetDrag: (aWidgetId, aArea) => {
          if (aWidgetId != this.id)
            return;
          aArea = aArea || this.currentArea;
          updateCombinedWidgetStyle(node, aArea, true);
        },

        // Hack. This can go away when the old menu panel goes away (post photon).
        // We need it right now for the case where we re-register the old-style
        // main menu panel if photon is disabled at runtime, and we automatically
        // put the widgets in there, so they get the right style in the panel.
        onAreaNodeRegistered: (aArea, aContainer) => {
          if (aContainer.ownerDocument == node.ownerDocument &&
              aArea == this.currentArea &&
              aArea == CustomizableUI.AREA_PANEL) {
            updateCombinedWidgetStyle(node, aArea, true);
          }
        },
      };
      CustomizableUI.addListener(listener);

      return node;
    }
  }, {
    id: "edit-controls",
    type: "custom",
    tooltiptext: "edit-controls.tooltiptext2",
    defaultArea: CustomizableUI.AREA_PANEL,
    onBuild(aDocument) {
      let buttons = [{
        id: "cut-button",
        command: "cmd_cut",
        label: true,
        tooltiptext: "tooltiptext2",
        shortcutId: "key_cut",
      }, {
        id: "copy-button",
        command: "cmd_copy",
        label: true,
        tooltiptext: "tooltiptext2",
        shortcutId: "key_copy",
      }, {
        id: "paste-button",
        command: "cmd_paste",
        label: true,
        tooltiptext: "tooltiptext2",
        shortcutId: "key_paste",
      }];

      let node = aDocument.createElementNS(kNSXUL, "toolbaritem");
      node.setAttribute("id", "edit-controls");
      node.setAttribute("label", CustomizableUI.getLocalizedProperty(this, "label"));
      node.setAttribute("title", CustomizableUI.getLocalizedProperty(this, "tooltiptext"));
      // Set this as an attribute in addition to the property to make sure we can style correctly.
      node.setAttribute("removable", "true");
      node.classList.add("chromeclass-toolbar-additional");
      node.classList.add("toolbaritem-combined-buttons");
      node.classList.add(kWidePanelItemClass);

      buttons.forEach(function(aButton, aIndex) {
        if (aIndex != 0)
          node.appendChild(aDocument.createElementNS(kNSXUL, "separator"));
        let btnNode = aDocument.createElementNS(kNSXUL, "toolbarbutton");
        setAttributes(btnNode, aButton);
        node.appendChild(btnNode);
      });

      updateCombinedWidgetStyle(node, this.currentArea);

      let listener = {
        onWidgetAdded: (aWidgetId, aArea, aPosition) => {
          if (aWidgetId != this.id)
            return;
          updateCombinedWidgetStyle(node, aArea);
        },

        onWidgetRemoved: (aWidgetId, aPrevArea) => {
          if (aWidgetId != this.id)
            return;
          // When a widget is demoted to the palette ('removed'), it's visual
          // style should change.
          updateCombinedWidgetStyle(node);
        },

        onWidgetReset: aWidgetNode => {
          if (aWidgetNode != node)
            return;
          updateCombinedWidgetStyle(node, this.currentArea);
        },

        onWidgetUndoMove: aWidgetNode => {
          if (aWidgetNode != node)
            return;
          updateCombinedWidgetStyle(node, this.currentArea);
        },

        onWidgetMoved: (aWidgetId, aArea) => {
          if (aWidgetId != this.id)
            return;
          updateCombinedWidgetStyle(node, aArea);
        },

        onWidgetInstanceRemoved: (aWidgetId, aDoc) => {
          if (aWidgetId != this.id || aDoc != aDocument)
            return;
          CustomizableUI.removeListener(listener);
        },

        onWidgetDrag: (aWidgetId, aArea) => {
          if (aWidgetId != this.id)
            return;
          aArea = aArea || this.currentArea;
          updateCombinedWidgetStyle(node, aArea);
        },

        // Hack. This can go away when the old menu panel goes away (post photon).
        // We need it right now for the case where we re-register the old-style
        // main menu panel if photon is disabled at runtime, and we automatically
        // put the widgets in there, so they get the right style in the panel.
        onAreaNodeRegistered: (aArea, aContainer) => {
          if (aContainer.ownerDocument == node.ownerDocument &&
              aArea == this.currentArea &&
              aArea == CustomizableUI.AREA_PANEL) {
            updateCombinedWidgetStyle(node, aArea);
          }
        },

        onWidgetOverflow(aWidgetNode) {
          if (aWidgetNode == node) {
            node.ownerGlobal.updateEditUIVisibility();
          }
        },
        onWidgetUnderflow(aWidgetNode) {
          if (aWidgetNode == node) {
            node.ownerGlobal.updateEditUIVisibility();
          }
        },
      };
      CustomizableUI.addListener(listener);

      return node;
    }
  },
  {
    id: "feed-button",
    type: "view",
    viewId: "PanelUI-feeds",
    tooltiptext: "feed-button.tooltiptext2",
    defaultArea: CustomizableUI.AREA_PANEL,
    onClick(aEvent) {
      let win = aEvent.target.ownerGlobal;
      let feeds = win.gBrowser.selectedBrowser.feeds;

      // Here, we only care about the case where we have exactly 1 feed and the
      // user clicked...
      let isClick = (aEvent.button == 0 || aEvent.button == 1);
      if (feeds && feeds.length == 1 && isClick) {
        aEvent.preventDefault();
        aEvent.stopPropagation();
        win.FeedHandler.subscribeToFeed(feeds[0].href, aEvent);
        CustomizableUI.hidePanelForNode(aEvent.target);
      }
    },
    onViewShowing(aEvent) {
      let doc = aEvent.target.ownerDocument;
      let container = doc.getElementById("PanelUI-feeds");
      let gotView = doc.defaultView.FeedHandler.buildFeedList(container, true);

      // For no feeds or only a single one, don't show the panel.
      if (!gotView) {
        aEvent.preventDefault();
        aEvent.stopPropagation();
      }
    },
    onCreated(node) {
      let win = node.ownerGlobal;
      let selectedBrowser = win.gBrowser.selectedBrowser;
      let feeds = selectedBrowser && selectedBrowser.feeds;
      if (!feeds || !feeds.length) {
        node.setAttribute("disabled", "true");
      }
    }
  }, {
    id: "characterencoding-button",
    label: "characterencoding-button2.label",
    type: "view",
    viewId: "PanelUI-characterEncodingView",
    tooltiptext: "characterencoding-button2.tooltiptext",
    defaultArea: CustomizableUI.AREA_PANEL,
    maybeDisableMenu(aDocument) {
      let window = aDocument.defaultView;
      return !(window.gBrowser &&
               window.gBrowser.selectedBrowser.mayEnableCharacterEncodingMenu);
    },
    populateList(aDocument, aContainerId, aSection) {
      let containerElem = aDocument.getElementById(aContainerId);

      containerElem.addEventListener("command", this.onCommand);

      let list = this.charsetInfo[aSection];

      for (let item of list) {
        let elem = aDocument.createElementNS(kNSXUL, "toolbarbutton");
        elem.setAttribute("label", item.label);
        elem.setAttribute("type", "checkbox");
        elem.section = aSection;
        elem.value = item.value;
        elem.setAttribute("class", "subviewbutton");
        containerElem.appendChild(elem);
      }
    },
    updateCurrentCharset(aDocument) {
      let currentCharset = aDocument.defaultView.gBrowser.selectedBrowser.characterSet;
      currentCharset = CharsetMenu.foldCharset(currentCharset);

      let pinnedContainer = aDocument.getElementById("PanelUI-characterEncodingView-pinned");
      let charsetContainer = aDocument.getElementById("PanelUI-characterEncodingView-charsets");
      let elements = [...(pinnedContainer.childNodes), ...(charsetContainer.childNodes)];

      this._updateElements(elements, currentCharset);
    },
    updateCurrentDetector(aDocument) {
      let detectorContainer = aDocument.getElementById("PanelUI-characterEncodingView-autodetect");
      let currentDetector;
      try {
        currentDetector = Services.prefs.getComplexValue(
          "intl.charset.detector", Ci.nsIPrefLocalizedString).data;
      } catch (e) {}

      this._updateElements(detectorContainer.childNodes, currentDetector);
    },
    _updateElements(aElements, aCurrentItem) {
      if (!aElements.length) {
        return;
      }
      let disabled = this.maybeDisableMenu(aElements[0].ownerDocument);
      for (let elem of aElements) {
        if (disabled) {
          elem.setAttribute("disabled", "true");
        } else {
          elem.removeAttribute("disabled");
        }
        if (elem.value.toLowerCase() == aCurrentItem.toLowerCase()) {
          elem.setAttribute("checked", "true");
        } else {
          elem.removeAttribute("checked");
        }
      }
    },
    onViewShowing(aEvent) {
      let document = aEvent.target.ownerDocument;

      let autoDetectLabelId = "PanelUI-characterEncodingView-autodetect-label";
      let autoDetectLabel = document.getElementById(autoDetectLabelId);
      if (!autoDetectLabel.hasAttribute("value")) {
        let label = CharsetBundle.GetStringFromName("charsetMenuAutodet");
        autoDetectLabel.setAttribute("value", label);
        this.populateList(document,
                          "PanelUI-characterEncodingView-pinned",
                          "pinnedCharsets");
        this.populateList(document,
                          "PanelUI-characterEncodingView-charsets",
                          "otherCharsets");
        this.populateList(document,
                          "PanelUI-characterEncodingView-autodetect",
                          "detectors");
      }
      this.updateCurrentDetector(document);
      this.updateCurrentCharset(document);
    },
    onCommand(aEvent) {
      let node = aEvent.target;
      if (!node.hasAttribute || !node.section) {
        return;
      }

      let window = node.ownerGlobal;
      let section = node.section;
      let value = node.value;

      // The behavior as implemented here is directly based off of the
      // `MultiplexHandler()` method in browser.js.
      if (section != "detectors") {
        window.BrowserSetForcedCharacterSet(value);
      } else {
        // Set the detector pref.
        try {
          Services.prefs.setStringPref("intl.charset.detector", value);
        } catch (e) {
          Cu.reportError("Failed to set the intl.charset.detector preference.");
        }
        // Prepare a browser page reload with a changed charset.
        window.BrowserCharsetReload();
      }
    },
    onCreated(aNode) {
      let document = aNode.ownerDocument;

      let updateButton = () => {
        if (this.maybeDisableMenu(document))
          aNode.setAttribute("disabled", "true");
        else
          aNode.removeAttribute("disabled");
      };

      let getPanel = () => {
        let {PanelUI} = document.ownerGlobal;
        if (PanelUI.overflowContents) {
          return document.getElementById("widget-overflow");
        }
        return PanelUI.panel;
      }

      if (CustomizableUI.getAreaType(this.currentArea) == CustomizableUI.TYPE_MENU_PANEL) {
        getPanel().addEventListener("popupshowing", updateButton);
      }

      let listener = {
        onWidgetAdded: (aWidgetId, aArea) => {
          if (aWidgetId != this.id)
            return;
          if (CustomizableUI.getAreaType(aArea) == CustomizableUI.TYPE_MENU_PANEL) {
            getPanel().addEventListener("popupshowing", updateButton);
          }
        },
        onWidgetRemoved: (aWidgetId, aPrevArea) => {
          if (aWidgetId != this.id)
            return;
          aNode.removeAttribute("disabled");
          if (CustomizableUI.getAreaType(aPrevArea) == CustomizableUI.TYPE_MENU_PANEL) {
            getPanel().removeEventListener("popupshowing", updateButton);
          }
        },
        onWidgetInstanceRemoved: (aWidgetId, aDoc) => {
          if (aWidgetId != this.id || aDoc != document)
            return;

          CustomizableUI.removeListener(listener);
          getPanel().removeEventListener("popupshowing", updateButton);
        }
      };
      CustomizableUI.addListener(listener);
      this.onInit();
    },
    onInit() {
      if (!this.charsetInfo) {
        this.charsetInfo = CharsetMenu.getData();
      }
    }
  }, {
    id: "email-link-button",
    tooltiptext: "email-link-button.tooltiptext3",
    onCommand(aEvent) {
      let win = aEvent.view;
      win.MailIntegration.sendLinkForBrowser(win.gBrowser.selectedBrowser)
    }
  }, {
    id: "containers-panelmenu",
    type: "view",
    viewId: "PanelUI-containers",
    hasObserver: false,
    onCreated(aNode) {
      let doc = aNode.ownerDocument;
      let win = doc.defaultView;
      let items = doc.getElementById("PanelUI-containersItems");

      let onItemCommand = function(aEvent) {
        let item = aEvent.target;
        if (item.hasAttribute("usercontextid")) {
          let userContextId = parseInt(item.getAttribute("usercontextid"));
          win.openUILinkIn(win.BROWSER_NEW_TAB_URL, "tab", {userContextId});
        }
      };
      items.addEventListener("command", onItemCommand);

      if (PrivateBrowsingUtils.isWindowPrivate(win)) {
        aNode.setAttribute("disabled", "true");
      }

      this.updateVisibility(aNode);

      if (!this.hasObserver) {
        Services.prefs.addObserver("privacy.userContext.enabled", this, true);
        this.hasObserver = true;
      }
    },
    onViewShowing(aEvent) {
      let doc = aEvent.target.ownerDocument;

      let items = doc.getElementById("PanelUI-containersItems");

      while (items.firstChild) {
        items.firstChild.remove();
      }

      let fragment = doc.createDocumentFragment();
      let bundle = doc.getElementById("bundle_browser");

      ContextualIdentityService.getPublicIdentities().forEach(identity => {
        let label = ContextualIdentityService.getUserContextLabel(identity.userContextId);

        let item = doc.createElementNS(kNSXUL, "toolbarbutton");
        item.setAttribute("label", label);
        item.setAttribute("usercontextid", identity.userContextId);
        item.setAttribute("class", "subviewbutton");
        item.setAttribute("data-identity-color", identity.color);
        item.setAttribute("data-identity-icon", identity.icon);

        fragment.appendChild(item);
      });

      fragment.appendChild(doc.createElementNS(kNSXUL, "menuseparator"));

      let item = doc.createElementNS(kNSXUL, "toolbarbutton");
      item.setAttribute("label", bundle.getString("userContext.aboutPage.label"));
      item.setAttribute("command", "Browser:OpenAboutContainers");
      item.setAttribute("class", "subviewbutton");
      fragment.appendChild(item);

      items.appendChild(fragment);
    },

    updateVisibility(aNode) {
      aNode.hidden = !Services.prefs.getBoolPref("privacy.userContext.enabled");
    },

    observe(aSubject, aTopic, aData) {
      let {instances} = CustomizableUI.getWidget("containers-panelmenu");
      for (let {node} of instances) {
        if (node) {
          this.updateVisibility(node);
        }
      }
    },

    QueryInterface: XPCOMUtils.generateQI([
      Ci.nsISupportsWeakReference,
      Ci.nsIObserver
    ]),
  }];

let preferencesButton = {
  id: "preferences-button",
  defaultArea: CustomizableUI.AREA_PANEL,
  onCommand(aEvent) {
    let win = aEvent.target.ownerGlobal;
    win.openPreferences(undefined, {origin: "preferencesButton"});
  }
};
if (AppConstants.platform == "win") {
  preferencesButton.label = "preferences-button.labelWin";
  preferencesButton.tooltiptext = "preferences-button.tooltipWin2";
} else if (AppConstants.platform == "macosx") {
  preferencesButton.tooltiptext = "preferences-button.tooltiptext.withshortcut";
  preferencesButton.shortcutId = "key_preferencesCmdMac";
} else {
  preferencesButton.tooltiptext = "preferences-button.tooltiptext2";
}
CustomizableWidgets.push(preferencesButton);

if (Services.prefs.getBoolPref("privacy.panicButton.enabled")) {
  CustomizableWidgets.push({
    id: "panic-button",
    type: "view",
    viewId: "PanelUI-panicView",
    _sanitizer: null,
    _ensureSanitizer() {
      if (!this.sanitizer) {
        let scope = {};
        Services.scriptloader.loadSubScript("chrome://browser/content/sanitize.js",
                                            scope);
        this._Sanitizer = scope.Sanitizer;
        this._sanitizer = new scope.Sanitizer();
        this._sanitizer.ignoreTimespan = false;
      }
    },
    _getSanitizeRange(aDocument) {
      let group = aDocument.getElementById("PanelUI-panic-timeSpan");
      return this._Sanitizer.getClearRange(+group.value);
    },
    forgetButtonCalled(aEvent) {
      let doc = aEvent.target.ownerDocument;
      this._ensureSanitizer();
      this._sanitizer.range = this._getSanitizeRange(doc);
      let group = doc.getElementById("PanelUI-panic-timeSpan");
      group.selectedItem = doc.getElementById("PanelUI-panic-5min");
      let itemsToClear = [
        "cookies", "history", "openWindows", "formdata", "sessions", "cache", "downloads"
      ];
      let newWindowPrivateState = PrivateBrowsingUtils.isWindowPrivate(doc.defaultView) ?
                                  "private" : "non-private";
      this._sanitizer.items.openWindows.privateStateForNewWindow = newWindowPrivateState;
      let promise = this._sanitizer.sanitize(itemsToClear);
      promise.then(function() {
        let otherWindow = Services.wm.getMostRecentWindow("navigator:browser");
        if (otherWindow.closed) {
          Cu.reportError("Got a closed window!");
        }
        if (otherWindow.PanicButtonNotifier) {
          otherWindow.PanicButtonNotifier.notify();
        } else {
          otherWindow.PanicButtonNotifierShouldNotify = true;
        }
      });
    },
    handleEvent(aEvent) {
      switch (aEvent.type) {
        case "command":
          this.forgetButtonCalled(aEvent);
          break;
      }
    },
    onViewShowing(aEvent) {
      let forgetButton = aEvent.target.querySelector("#PanelUI-panic-view-button");
      forgetButton.addEventListener("command", this);
    },
    onViewHiding(aEvent) {
      let forgetButton = aEvent.target.querySelector("#PanelUI-panic-view-button");
      forgetButton.removeEventListener("command", this);
    },
  });
}

if ((AppConstants.E10S_TESTING_ONLY) && (!AppConstants.isPlatformAndVersionAtMost("macosx", 13))) {
  if (Services.appinfo.browserTabsRemoteAutostart) {
    CustomizableWidgets.push({
      id: "e10s-button",
      defaultArea: CustomizableUI.AREA_PANEL,
      onBuild(aDocument) {
        let node = aDocument.createElementNS(kNSXUL, "toolbarbutton");
        node.setAttribute("label", CustomizableUI.getLocalizedProperty(this, "label"));
        node.setAttribute("tooltiptext", CustomizableUI.getLocalizedProperty(this, "tooltiptext"));
      },
      onCommand(aEvent) {
        let win = aEvent.view;
        win.OpenBrowserWindow({remote: false});
      },
    });
  }
}
