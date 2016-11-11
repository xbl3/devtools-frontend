/*
 * Copyright (C) 2012 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * @implements {WebInspector.TargetManager.Observer}
 * @unrestricted
 */
WebInspector.Linkifier = class {
  /**
   * @param {number=} maxLengthForDisplayedURLs
   * @param {boolean=} useLinkDecorator
   */
  constructor(maxLengthForDisplayedURLs, useLinkDecorator) {
    this._maxLength = maxLengthForDisplayedURLs || WebInspector.Linkifier.MaxLengthForDisplayedURLs;
    /** @type {!Map<!WebInspector.Target, !Array<!Element>>} */
    this._anchorsByTarget = new Map();
    /** @type {!Map<!WebInspector.Target, !WebInspector.LiveLocationPool>} */
    this._locationPoolByTarget = new Map();
    this._useLinkDecorator = !!useLinkDecorator;
    WebInspector.Linkifier._instances.add(this);
    WebInspector.targetManager.observeTargets(this);
  }

  /**
   * @param {!WebInspector.LinkDecorator} decorator
   */
  static setLinkDecorator(decorator) {
    console.assert(!WebInspector.Linkifier._decorator, 'Cannot re-register link decorator.');
    WebInspector.Linkifier._decorator = decorator;
    decorator.addEventListener(WebInspector.LinkDecorator.Events.LinkIconChanged, onLinkIconChanged);
    for (var linkifier of WebInspector.Linkifier._instances)
      linkifier._updateAllAnchorDecorations();

    /**
     * @param {!WebInspector.Event} event
     */
    function onLinkIconChanged(event) {
      var uiSourceCode = /** @type {!WebInspector.UISourceCode} */(event.data);
      var links = uiSourceCode[WebInspector.Linkifier._sourceCodeAnchors] || [];
      for (var link of links)
        WebInspector.Linkifier._updateLinkDecorations(link);
    }
  }

  _updateAllAnchorDecorations() {
    for (var anchors of this._anchorsByTarget.values()) {
      for (var anchor of anchors)
        WebInspector.Linkifier._updateLinkDecorations(anchor);
    }
  }

  /**
   * @param {?WebInspector.Linkifier.LinkHandler} handler
   */
  static setLinkHandler(handler) {
    WebInspector.Linkifier._linkHandler = handler;
  }

  /**
   * @param {string} url
   * @param {number=} lineNumber
   * @return {boolean}
   */
  static handleLink(url, lineNumber) {
    if (!WebInspector.Linkifier._linkHandler)
      return false;
    return WebInspector.Linkifier._linkHandler.handleLink(url, lineNumber);
  }

  /**
   * @param {!Object} revealable
   * @param {string} text
   * @param {string=} fallbackHref
   * @param {number=} fallbackLineNumber
   * @param {string=} title
   * @param {string=} classes
   * @return {!Element}
   */
  static linkifyUsingRevealer(revealable, text, fallbackHref, fallbackLineNumber, title, classes) {
    var a = createElement('a');
    a.className = (classes || '') + ' webkit-html-resource-link';
    a.textContent = text.trimMiddle(WebInspector.Linkifier.MaxLengthForDisplayedURLs);
    a.title = title || text;
    if (fallbackHref) {
      a.href = fallbackHref;
      a.lineNumber = fallbackLineNumber;
    }

    /**
     * @param {!Event} event
     * @this {Object}
     */
    function clickHandler(event) {
      event.stopImmediatePropagation();
      event.preventDefault();
      if (fallbackHref && WebInspector.Linkifier.handleLink(fallbackHref, fallbackLineNumber))
        return;

      WebInspector.Revealer.reveal(this);
    }
    a.addEventListener('click', clickHandler.bind(revealable), false);
    return a;
  }

  /**
   * @param {!Element} anchor
   * @return {?WebInspector.UILocation} uiLocation
   */
  static uiLocationByAnchor(anchor) {
    return anchor[WebInspector.Linkifier._uiLocationSymbol];
  }

  /**
   * @param {!Element} anchor
   * @param {!WebInspector.UILocation} uiLocation
   */
  static _bindUILocation(anchor, uiLocation) {
    anchor[WebInspector.Linkifier._uiLocationSymbol] = uiLocation;
    if (!uiLocation)
      return;
    var uiSourceCode = uiLocation.uiSourceCode;
    var sourceCodeAnchors = uiSourceCode[WebInspector.Linkifier._sourceCodeAnchors];
    if (!sourceCodeAnchors) {
      sourceCodeAnchors = new Set();
      uiSourceCode[WebInspector.Linkifier._sourceCodeAnchors] = sourceCodeAnchors;
    }
    sourceCodeAnchors.add(anchor);
  }

  /**
   * @param {!Element} anchor
   */
  static _unbindUILocation(anchor) {
    if (!anchor[WebInspector.Linkifier._uiLocationSymbol])
      return;

    var uiSourceCode = anchor[WebInspector.Linkifier._uiLocationSymbol].uiSourceCode;
    anchor[WebInspector.Linkifier._uiLocationSymbol] = null;
    var sourceCodeAnchors = uiSourceCode[WebInspector.Linkifier._sourceCodeAnchors];
    if (sourceCodeAnchors)
      sourceCodeAnchors.delete(anchor);
  }

  /**
   * @param {!WebInspector.Target} target
   * @param {string} scriptId
   * @param {number} lineNumber
   * @param {number=} columnNumber
   * @return {string}
   */
  static liveLocationText(target, scriptId, lineNumber, columnNumber) {
    var debuggerModel = WebInspector.DebuggerModel.fromTarget(target);
    if (!debuggerModel)
      return '';
    var script = debuggerModel.scriptForId(scriptId);
    if (!script)
      return '';
    var location = /** @type {!WebInspector.DebuggerModel.Location} */ (
        debuggerModel.createRawLocation(script, lineNumber, columnNumber || 0));
    var uiLocation = /** @type {!WebInspector.UILocation} */ (
        WebInspector.debuggerWorkspaceBinding.rawLocationToUILocation(location));
    return uiLocation.linkText();
  }

  /**
   * @override
   * @param {!WebInspector.Target} target
   */
  targetAdded(target) {
    this._anchorsByTarget.set(target, []);
    this._locationPoolByTarget.set(target, new WebInspector.LiveLocationPool());
  }

  /**
   * @override
   * @param {!WebInspector.Target} target
   */
  targetRemoved(target) {
    var locationPool = /** @type {!WebInspector.LiveLocationPool} */ (this._locationPoolByTarget.remove(target));
    locationPool.disposeAll();
    var anchors = this._anchorsByTarget.remove(target);
    for (var anchor of anchors) {
      delete anchor[WebInspector.Linkifier._liveLocationSymbol];
      WebInspector.Linkifier._unbindUILocation(anchor);
      var fallbackAnchor = anchor[WebInspector.Linkifier._fallbackAnchorSymbol];
      if (fallbackAnchor) {
        anchor.href = fallbackAnchor.href;
        anchor.lineNumber = fallbackAnchor.lineNumber;
        anchor.title = fallbackAnchor.title;
        anchor.className = fallbackAnchor.className;
        anchor.textContent = fallbackAnchor.textContent;
        delete anchor[WebInspector.Linkifier._fallbackAnchorSymbol];
      }
    }
  }

  /**
   * @param {?WebInspector.Target} target
   * @param {?string} scriptId
   * @param {string} sourceURL
   * @param {number} lineNumber
   * @param {number=} columnNumber
   * @param {string=} classes
   * @return {?Element}
   */
  maybeLinkifyScriptLocation(target, scriptId, sourceURL, lineNumber, columnNumber, classes) {
    var fallbackAnchor =
        sourceURL ? WebInspector.linkifyResourceAsNode(sourceURL, lineNumber, columnNumber, classes) : null;
    if (!target || target.isDisposed())
      return fallbackAnchor;
    var debuggerModel = WebInspector.DebuggerModel.fromTarget(target);
    if (!debuggerModel)
      return fallbackAnchor;

    var rawLocation =
        (scriptId ? debuggerModel.createRawLocationByScriptId(scriptId, lineNumber, columnNumber || 0) : null) ||
        debuggerModel.createRawLocationByURL(sourceURL, lineNumber, columnNumber || 0);
    if (!rawLocation)
      return fallbackAnchor;

    var anchor = this._createAnchor(classes);
    var liveLocation = WebInspector.debuggerWorkspaceBinding.createLiveLocation(
        rawLocation, this._updateAnchor.bind(this, anchor),
        /** @type {!WebInspector.LiveLocationPool} */ (this._locationPoolByTarget.get(rawLocation.target())));
    var anchors = /** @type {!Array<!Element>} */ (this._anchorsByTarget.get(rawLocation.target()));
    anchors.push(anchor);
    anchor[WebInspector.Linkifier._liveLocationSymbol] = liveLocation;
    anchor[WebInspector.Linkifier._fallbackAnchorSymbol] = fallbackAnchor;
    return anchor;
  }

  /**
   * @param {?WebInspector.Target} target
   * @param {?string} scriptId
   * @param {string} sourceURL
   * @param {number} lineNumber
   * @param {number=} columnNumber
   * @param {string=} classes
   * @return {!Element}
   */
  linkifyScriptLocation(target, scriptId, sourceURL, lineNumber, columnNumber, classes) {
    return this.maybeLinkifyScriptLocation(target, scriptId, sourceURL, lineNumber, columnNumber, classes) ||
        WebInspector.linkifyResourceAsNode(sourceURL, lineNumber, columnNumber, classes);
  }

  /**
   * @param {!WebInspector.DebuggerModel.Location} rawLocation
   * @param {string} fallbackUrl
   * @param {string=} classes
   * @return {!Element}
   */
  linkifyRawLocation(rawLocation, fallbackUrl, classes) {
    return this.linkifyScriptLocation(
        rawLocation.target(), rawLocation.scriptId, fallbackUrl, rawLocation.lineNumber, rawLocation.columnNumber,
        classes);
  }

  /**
   * @param {?WebInspector.Target} target
   * @param {!Protocol.Runtime.CallFrame} callFrame
   * @param {string=} classes
   * @return {?Element}
   */
  maybeLinkifyConsoleCallFrame(target, callFrame, classes) {
    return this.maybeLinkifyScriptLocation(
        target, callFrame.scriptId, callFrame.url, callFrame.lineNumber, callFrame.columnNumber, classes);
  }

  /**
   * @param {!WebInspector.Target} target
   * @param {!Protocol.Runtime.StackTrace} stackTrace
   * @param {string=} classes
   * @return {!Element}
   */
  linkifyStackTraceTopFrame(target, stackTrace, classes) {
    console.assert(stackTrace.callFrames && stackTrace.callFrames.length);

    var topFrame = stackTrace.callFrames[0];
    var fallbackAnchor =
        WebInspector.linkifyResourceAsNode(topFrame.url, topFrame.lineNumber, topFrame.columnNumber, classes);
    if (target.isDisposed())
      return fallbackAnchor;

    var debuggerModel = WebInspector.DebuggerModel.fromTarget(target);
    var rawLocations = debuggerModel.createRawLocationsByStackTrace(stackTrace);
    if (rawLocations.length === 0)
      return fallbackAnchor;

    var anchor = this._createAnchor(classes);
    var liveLocation = WebInspector.debuggerWorkspaceBinding.createStackTraceTopFrameLiveLocation(
        rawLocations, this._updateAnchor.bind(this, anchor),
        /** @type {!WebInspector.LiveLocationPool} */ (this._locationPoolByTarget.get(target)));
    var anchors = /** @type {!Array<!Element>} */ (this._anchorsByTarget.get(target));
    anchors.push(anchor);
    anchor[WebInspector.Linkifier._liveLocationSymbol] = liveLocation;
    anchor[WebInspector.Linkifier._fallbackAnchorSymbol] = fallbackAnchor;
    return anchor;
  }

  /**
   * @param {!WebInspector.CSSLocation} rawLocation
   * @param {string=} classes
   * @return {!Element}
   */
  linkifyCSSLocation(rawLocation, classes) {
    var anchor = this._createAnchor(classes);
    var liveLocation = WebInspector.cssWorkspaceBinding.createLiveLocation(
        rawLocation, this._updateAnchor.bind(this, anchor),
        /** @type {!WebInspector.LiveLocationPool} */ (this._locationPoolByTarget.get(rawLocation.target())));
    var anchors = /** @type {!Array<!Element>} */ (this._anchorsByTarget.get(rawLocation.target()));
    anchors.push(anchor);
    anchor[WebInspector.Linkifier._liveLocationSymbol] = liveLocation;
    return anchor;
  }

  /**
   * @param {!WebInspector.Target} target
   * @param {!Element} anchor
   */
  disposeAnchor(target, anchor) {
    WebInspector.Linkifier._unbindUILocation(anchor);
    delete anchor[WebInspector.Linkifier._fallbackAnchorSymbol];
    var liveLocation = anchor[WebInspector.Linkifier._liveLocationSymbol];
    if (liveLocation)
      liveLocation.dispose();
    delete anchor[WebInspector.Linkifier._liveLocationSymbol];
  }

  /**
   * @param {string=} classes
   * @return {!Element}
   */
  _createAnchor(classes) {
    var anchor = createElement('a');
    if (this._useLinkDecorator)
      anchor[WebInspector.Linkifier._enableDecoratorSymbol] = true;
    anchor.className = (classes || '') + ' webkit-html-resource-link';

    /**
     * @param {!Event} event
     */
    function clickHandler(event) {
      var uiLocation = anchor[WebInspector.Linkifier._uiLocationSymbol];
      if (!uiLocation)
        return;

      event.consume(true);
      if (WebInspector.Linkifier.handleLink(uiLocation.uiSourceCode.url(), uiLocation.lineNumber))
        return;
      WebInspector.Revealer.reveal(uiLocation);
    }
    anchor.addEventListener('click', clickHandler, false);
    return anchor;
  }

  reset() {
    for (var target of this._anchorsByTarget.keysArray()) {
      this.targetRemoved(target);
      this.targetAdded(target);
    }
  }

  dispose() {
    for (var target of this._anchorsByTarget.keysArray())
      this.targetRemoved(target);
    WebInspector.targetManager.unobserveTargets(this);
    WebInspector.Linkifier._instances.delete(this);
  }

  /**
   * @param {!Element} anchor
   * @param {!WebInspector.LiveLocation} liveLocation
   */
  _updateAnchor(anchor, liveLocation) {
    WebInspector.Linkifier._unbindUILocation(anchor);
    var uiLocation = liveLocation.uiLocation();
    if (!uiLocation)
      return;

    WebInspector.Linkifier._bindUILocation(anchor, uiLocation);
    var text = uiLocation.linkText();
    text = text.replace(/([a-f0-9]{7})[a-f0-9]{13}[a-f0-9]*/g, '$1\u2026');
    if (this._maxLength)
      text = text.trimMiddle(this._maxLength);
    anchor.textContent = text;

    var titleText = uiLocation.uiSourceCode.url();
    if (typeof uiLocation.lineNumber === 'number')
      titleText += ':' + (uiLocation.lineNumber + 1);
    anchor.title = titleText;
    anchor.classList.toggle('webkit-html-blackbox-link', liveLocation.isBlackboxed());
    WebInspector.Linkifier._updateLinkDecorations(anchor);
  }

  /**
   * @param {!Element} anchor
   */
  static _updateLinkDecorations(anchor) {
    if (!anchor[WebInspector.Linkifier._enableDecoratorSymbol])
      return;
    var uiLocation = anchor[WebInspector.Linkifier._uiLocationSymbol];
    if (!WebInspector.Linkifier._decorator || !uiLocation)
      return;
    var icon = anchor[WebInspector.Linkifier._iconSymbol];
    if (icon)
      icon.remove();
    icon = WebInspector.Linkifier._decorator.linkIcon(uiLocation.uiSourceCode);
    if (icon) {
      icon.style.setProperty('margin-right', '2px');
      anchor.insertBefore(icon, anchor.firstChild);
    }
    anchor[WebInspector.Linkifier._iconSymbol] = icon;
  }
};

/** @type {!Set<!WebInspector.Linkifier>} */
WebInspector.Linkifier._instances = new Set();
/** @type {?WebInspector.LinkDecorator} */
WebInspector.Linkifier._decorator = null;

WebInspector.Linkifier._iconSymbol = Symbol('Linkifier.iconSymbol');
WebInspector.Linkifier._enableDecoratorSymbol = Symbol('Linkifier.enableIconsSymbol');
WebInspector.Linkifier._sourceCodeAnchors = Symbol('Linkifier.anchors');
WebInspector.Linkifier._uiLocationSymbol = Symbol('uiLocation');
WebInspector.Linkifier._fallbackAnchorSymbol = Symbol('fallbackAnchor');
WebInspector.Linkifier._liveLocationSymbol = Symbol('liveLocation');

/**
 * The maximum number of characters to display in a URL.
 * @const
 * @type {number}
 */
WebInspector.Linkifier.MaxLengthForDisplayedURLs = 150;

/**
 * The maximum length before strings are considered too long for finding URLs.
 * @const
 * @type {number}
 */
WebInspector.Linkifier.MaxLengthToIgnoreLinkifier = 10000;

/**
 * @interface
 */
WebInspector.Linkifier.LinkHandler = function() {};

WebInspector.Linkifier.LinkHandler.prototype = {
  /**
   * @param {string} url
   * @param {number=} lineNumber
   * @return {boolean}
   */
  handleLink: function(url, lineNumber) {}
};

/**
 * @extends {WebInspector.EventTarget}
 * @interface
 */
WebInspector.LinkDecorator = function() {};

WebInspector.LinkDecorator.prototype = {
  /**
   * @param {!WebInspector.UISourceCode} uiSourceCode
   * @return {?WebInspector.Icon}
   */
  linkIcon: function(uiSourceCode) {}
};

WebInspector.LinkDecorator.Events = {
  LinkIconChanged: Symbol('LinkIconChanged')
};

/**
 * @param {string} string
 * @param {function(string,string,number=,number=):!Node} linkifier
 * @return {!DocumentFragment}
 */
WebInspector.linkifyStringAsFragmentWithCustomLinkifier = function(string, linkifier) {
  var container = createDocumentFragment();
  var linkStringRegEx =
      /(?:[a-zA-Z][a-zA-Z0-9+.-]{2,}:\/\/|data:|www\.)[\w$\-_+*'=\|\/\\(){}[\]^%@&#~,:;.!?]{2,}[\w$\-_+*=\|\/\\({^%@&#~]/;
  var pathLineRegex = /(?:\/[\w\.-]*)+\:[\d]+/;

  while (string && string.length < WebInspector.Linkifier.MaxLengthToIgnoreLinkifier) {
    var linkString = linkStringRegEx.exec(string) || pathLineRegex.exec(string);
    if (!linkString)
      break;

    linkString = linkString[0];
    var linkIndex = string.indexOf(linkString);
    var nonLink = string.substring(0, linkIndex);
    container.appendChild(createTextNode(nonLink));

    var title = linkString;
    var realURL = (linkString.startsWith('www.') ? 'http://' + linkString : linkString);
    var splitResult = WebInspector.ParsedURL.splitLineAndColumn(realURL);
    var linkNode;
    if (splitResult)
      linkNode = linkifier(title, splitResult.url, splitResult.lineNumber, splitResult.columnNumber);
    else
      linkNode = linkifier(title, realURL);

    container.appendChild(linkNode);
    string = string.substring(linkIndex + linkString.length, string.length);
  }

  if (string)
    container.appendChild(createTextNode(string));

  return container;
};

/**
 * @param {string} string
 * @return {!DocumentFragment}
 */
WebInspector.linkifyStringAsFragment = function(string) {
  /**
   * @param {string} title
   * @param {string} url
   * @param {number=} lineNumber
   * @param {number=} columnNumber
   * @return {!Node}
   */
  function linkifier(title, url, lineNumber, columnNumber) {
    var isExternal =
        !WebInspector.resourceForURL(url) && !WebInspector.networkMapping.uiSourceCodeForURLForAnyTarget(url);
    var urlNode = WebInspector.linkifyURLAsNode(url, title, undefined, isExternal);
    if (typeof lineNumber !== 'undefined') {
      urlNode.lineNumber = lineNumber;
      if (typeof columnNumber !== 'undefined')
        urlNode.columnNumber = columnNumber;
    }

    return urlNode;
  }

  return WebInspector.linkifyStringAsFragmentWithCustomLinkifier(string, linkifier);
};

/**
 * @param {string} url
 * @param {number=} lineNumber
 * @param {number=} columnNumber
 * @param {string=} classes
 * @param {string=} tooltipText
 * @param {string=} urlDisplayName
 * @return {!Element}
 */
WebInspector.linkifyResourceAsNode = function(url, lineNumber, columnNumber, classes, tooltipText, urlDisplayName) {
  if (!url) {
    var element = createElementWithClass('span', classes);
    element.textContent = urlDisplayName || WebInspector.UIString('(unknown)');
    return element;
  }
  var linkText = urlDisplayName || WebInspector.displayNameForURL(url);
  if (typeof lineNumber === 'number')
    linkText += ':' + (lineNumber + 1);
  var anchor = WebInspector.linkifyURLAsNode(url, linkText, classes, false, tooltipText);
  anchor.lineNumber = lineNumber;
  anchor.columnNumber = columnNumber;
  return anchor;
};

/**
 * @param {!WebInspector.NetworkRequest} request
 * @return {!Element}
 */
WebInspector.linkifyRequestAsNode = function(request) {
  var anchor = WebInspector.linkifyURLAsNode(request.url);
  anchor.requestId = request.requestId;
  return anchor;
};
