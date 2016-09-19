/******************************************************************************
 * Copyright © 2013-2016 The Nxt Core Developers.                             *
 *                                                                            *
 * See the AUTHORS.txt, DEVELOPER-AGREEMENT.txt and LICENSE.txt files at      *
 * the top-level directory of this distribution for the individual copyright  *
 * holder information and the developer policies on copyright and licensing.  *
 *                                                                            *
 * Unless otherwise agreed in a custom licensing agreement, no part of the    *
 * Nxt software, including this file, may be copied, modified, propagated,    *
 * or distributed except according to the terms contained in the LICENSE.txt  *
 * file.                                                                      *
 *                                                                            *
 * Removal or modification of this copyright notice is prohibited.            *
 *                                                                            *
 ******************************************************************************/

function RemoteNode(peerData) {
    this.address = peerData.address;
    this.announcedAddress = peerData.announcedAddress;
    this.port = peerData.apiPort;
    this.isSsl = peerData.isSsl ? true : false; // For now only nodes specified by the user can use SSL since we need trusted certificate
    this.blacklistedUntil = 0;
    this.connectionTime = new Date();
}

RemoteNode.prototype.getUrl = function () {
    return (this.isSsl ? "https://" : "http://") + this.address + ":" + this.port;
};

RemoteNode.prototype.isBlacklisted = function () {
    return new Date().getTime() < this.blacklistedUntil;
};

RemoteNode.prototype.blacklist = function () {
    var blacklistedUntil = new Date().getTime() + 10 * 60 * 1000;
    NRS.logConsole("Blacklist " + this.address + " until " + new Date(blacklistedUntil).format("isoDateTime"));
    this.blacklistedUntil = blacklistedUntil;
};

function RemoteNodesManager(isTestnet) {
    this.isTestnet = isTestnet;
    this.nodes = {};
    this.init();
}

function isRemoteNodeServicesAvailable(node) {
    if (node.services instanceof Array && (node.services.indexOf("API") >= 0)) {
        if (!NRS.isRequireCors() || node.services.indexOf("CORS") >= 0) {
            return true;
        }
    }
    return false;
}

RemoteNodesManager.prototype.addRemoteNodes = function (peersData) {
    var mgr = this;
    $.each(peersData, function(index, peerData) {
        if (isRemoteNodeServicesAvailable(peerData)) {
            var oldNode = mgr.nodes[peerData.address];
            var newNode = new RemoteNode(peerData);
            if (oldNode) {
                newNode.blacklistedUntil = oldNode.blacklistedUntil;
            }
            mgr.nodes[peerData.address] = newNode;
            NRS.logConsole("Found remote node " + peerData.address + " blacklisted " + newNode.isBlacklisted());
        }
    });
};

RemoteNodesManager.prototype.addBootstrapNode = function (resolve, reject) {
    var node = new RemoteNode({
        address: NRS.mobileSettings.remote_node_address,
        announcedAddress: NRS.mobileSettings.remote_node_address,
        apiPort: NRS.mobileSettings.remote_node_port,
        isSsl: NRS.mobileSettings.is_remote_node_ssl
    });
    var mgr = this;
    NRS.logConsole("Connecting to address specified by user " + node.address);
    NRS.sendRequest("getState", { "_extra": node }, function(response, data) {
        if (response.errorCode || !isRemoteNodeServicesAvailable(response)) {
            if (response.errorCode) {
                NRS.logConsole("Bootstrap node cannot be used " + response.errorDescription);
            } else {
                NRS.logConsole("Bootstrap node does not provide the required services");
            }
            $.growl("Cannot connect to configured node, connecting to a random node");
            NRS.remoteNodesMgr.addBootstrapNodes(resolve, reject);
            return;
        }
        NRS.logConsole("Adding bootstrap node " + response.address);
        var node = data["_extra"];
        mgr.nodes[node.address] = node;
        resolve();
    }, true, true, node);
};

RemoteNodesManager.prototype.addBootstrapNodes = function (resolve, reject) {
    var peersData = this.REMOTE_NODES_BOOTSTRAP;
    var mgr = this;
    var data = {state: "CONNECTED", includePeerInfo: true};
    var rejections = 0;
    peersData = NRS.getRandomPermutation(peersData);
    for (var i=0; i < peersData.length && i < NRS.mobileSettings.bootstrap_nodes_count; i++) {
        var peerData = peersData[i];
        if (!isRemoteNodeServicesAvailable(peerData)) {
            continue;
        }
        var node = new RemoteNode(peerData);
        data["_extra"] = node;
        NRS.logConsole("Connecting to bootstrap node " + node.address);
        NRS.sendRequest("getPeers", data, function(response, data) {
            if (response.errorCode) {
                NRS.logConsole("Bootstrap node returned error " + response.errorDescription);
                rejections ++;
                if (rejections == 3) {
                    reject();
                }
                return;
            }
            var responseNode = data["_extra"];
            NRS.logConsole("Adding bootstrap node " + responseNode.address + " response time " + (new Date() - responseNode.connectionTime) + " ms");
            mgr.nodes[responseNode.address] = responseNode;
            if (NRS.mobileSettings.is_testnet && Object.keys(mgr.nodes).length == 1 || Object.keys(mgr.nodes).length == 3) {
                resolve();
            }
        }, true, true, node);
    }
};

RemoteNodesManager.prototype.getRandomNode = function (ignoredAddresses) {
    var addresses = Object.keys(this.nodes);
    if (addresses.length == 0) {
        NRS.logConsole("Cannot get random node. No nodes available");
        return null;
    }
    var index = Math.floor((Math.random() * addresses.length));
    var startIndex = index;
    var node;
    do {
        var address = addresses[index];
        if (ignoredAddresses instanceof Array && ignoredAddresses.indexOf(address) >= 0) {
            node = null;
        } else {
            node = this.nodes[address];
            if (node != null && node.isBlacklisted()) {
                node = null;
            }
        }
        index = (index+1) % addresses.length;
    } while(node == null && index != startIndex);

    return node;
};

RemoteNodesManager.prototype.getRandomNodes = function (count, ignoredAddresses) {
    var processedAddresses = [];
    if (ignoredAddresses instanceof Array) {
        processedAddresses.concat(ignoredAddresses)
    }

    var result = [];
    for (var i = 0; i < count; i++) {
        var node = this.getRandomNode(processedAddresses);
        if (node) {
            processedAddresses.push(node.address);
            result.push(node);
        }
    }
    return result;
};

RemoteNodesManager.prototype.findMoreNodes = function (isReschedule) {
    var nodesMgr = this;
    var node = this.getRandomNode();
    if (node == null) {
        return;
    }
    var data = {state: "CONNECTED", includePeerInfo: true};
    NRS.sendRequest("getPeers", data, function (response) {
        if (response.peers) {
            nodesMgr.addRemoteNodes(response.peers);
        }
        if (isReschedule) {
            setTimeout(function () {
                nodesMgr.findMoreNodes(true);
            }, 30000);
        }
    }, true, true, node);
};

RemoteNodesManager.prototype.init = function () {
    if (NRS.isMobileApp()) {
        //load the remote nodes bootstrap file only for mobile wallet
        jQuery.ajaxSetup({ async: false });
        $.getScript(this.isTestnet ? "js/data/remotenodesbootstrap.testnet.js" : "js/data/remotenodesbootstrap.mainnet.js");
        jQuery.ajaxSetup({async: true});
    }
};
