// When false nothing will be logged. 
// Configuration goes here.
require('./config.js');

process.setMaxListeners(0);

if (!configuration.DEBUG) {
	console.log = () => {};
}


const Discord = require("discord.js");
const fs = require('fs');
let net;
let netOptions = {};

if (configuration.tlsEnabled) {
	net = require('tls');
	netOptions = {
		key: fs.readFileSync(configuration.tlsOptions.keyPath),
		cert: fs.readFileSync(configuration.tlsOptions.certPath)
	}

} else {
	net = require('net');
}

//
// Shortener
//

let http, attachmentServer, shortCache = {}, codeCache = {}, shorten;

if (configuration.attachmentServer) {
	http = require('http');
	attachmentServer = http.createServer((request, response) => {
		if (url = shortCache[request.url.substring(1)]) {
			response.writeHead(301, {'Location': url});
			response.end('HTTP/1.1 301 Moved Permanently');
		}  else if (code = codeCache[request.url.substring(1)]) {
			response.writeHead(200, {'Content-Type': 'application/octet-stream'});
			response.write(code);
			response.end();
		}else {
			response.writeHead(404);
			response.end('HTTP/1.1 404 Not Found');
		}
	}).listen(configuration.attachmentServer.listenPort, configuration.attachmentServer.hostname);
	shorten = url => {
		let shortened = Math.random().toString(36).substring(7) + '.' + url.split('.').pop();
		if (shortCache.length >= configuration.attachmentServer.cacheSize)
			shortCache.pop();
		shortCache[shortened] = url;
		console.log(url, ' -> ', shortened);
		return `http://${configuration.attachmentServer.hostname}:${configuration.attachmentServer.listenPort}/${shortened}`;
	};
}

//
// Let's ready some variables and stuff we will use later on.
//

// Object which will contain channel information.
let ircDetails = {
	DMserver: {
		lastPRIVMSG: []
	}
};

// Since we want a seperate connection for each discord server we will need to store our sockets. 
let ircClients = [];

// Simply used to give each new socket a unique number. 
let ircClientCount = 0;

// This is used to make sure that if discord reconnects not everything is wiped. 
let discordFirstConnection = true;

// Max line lenght for irc messages. 
const maxLineLength = 510;

// Extension dictionary for code handling
// From highlight.js
const langs = ["1c","abnf","accesslog","actionscript","ada","angelscript","apache","applescript","arcade","arduino","armasm","asciidoc","aspectj","autohotkey","autoit","avrasm","awk","axapta","bash","basic","bnf","brainfuck","cal","capnproto","ceylon","clean","clojure","clojure-repl","cmake","coffeescript","coq","cos","cpp","crmsh","crystal","cs","csp","css","d","dart","delphi","diff","django","dns","dockerfile","dos","dsconfig","dts","dust","ebnf","elixir","elm","erb","erlang","erlang-repl","excel","fix","flix","fortran","fsharp","gams","gauss","gcode","gherkin","glsl","gml","go","golo","gradle","groovy","haml","handlebars","haskell","haxe","hsp","htmlbars","http","hy","inform7","ini","irpf90","isbl","java","javascript","jboss-cli","json","julia","julia-repl","kotlin","lasso","ldif","leaf","less","lisp","livecodeserver","livescript","llvm","lsl","lua","makefile","markdown","mathematica","matlab","maxima","mel","mercury","mipsasm","mizar","mojolicious","monkey","moonscript","n1ql","nginx","nimrod","nix","nsis","objectivec","ocaml","openscad","oxygene","parser3","perl","pf","pgsql","php","plaintext","pony","powershell","processing","profile","prolog","properties","protobuf","puppet","purebasic","python","q","qml","r","reasonml","rib","roboconf","routeros","rsl","ruby","ruleslanguage","rust","sas","scala","scheme","scilab","scss","shell","smali","smalltalk","sml","sqf","sql","stan","stata","step21","stylus","subunit","swift","taggerscript","tap","tcl","tex","thrift","tp","twig","typescript","vala","vbnet","vbscript","vbscript-html","verilog","vhdl","vim","x86asm","xl","xml","xquery","yaml","zephir"];
const langExts = []
// Handwritten...
langExts[2] = 'log';
langExts[3] = 'as';
langExts[5] = 'as';
langExts[9] = 'ino';
langExts[13] = 'ahk';
langExts[18] = 'sh';
langExts[19] = 'bas';
langExts[21] = 'bf';
langExts[26] = 'clj';
langExts[29] = 'coffee';
langExts[58] = 'f';
langExts[72] = 'hs';
langExts[83] = 'js';
langExts[88] = 'kt';
langExts[99] = 'mk';
langExts[110] = 'moon';
langExts[116] = 'm';
langExts[127] = 'ps1';
langExts[134] = 'pb';
langExts[135] = 'py';
langExts[121] = 'pl';
langExts[125] = 'txt';
langExts[144] = 'rb';
langExts[146] = 'rs';
langExts[149] = 'scheme';
langExts[152] = 'sh';
langExts[154] = 'st';
langExts[171] = 'ts';
langExts[173] = 'vb';

//
// Generic functions
//

// Function that parses irc messages. 
// Shamelessly stolen from node-irc https://github.com/aredridel/node-ircd
function parseMessage(line) {
	let message = {};
	let m = /(:[^ ]+ )?([A-Z0-9]+)(?: (.*))?/i.exec(line);
	if (!m) {
		message['error'] = 'Unable to parse message';
	} else {
		let i;
		if (m[3] && (i = m[3].indexOf(':')) !== -1) {
			let rest = m[3].slice(i + 1);
			message.params = i > 0 ? m[3].slice(0, i).trimEnd().split(' ') : [];
			//message.params = m[3].slice(0, i - 1).split(' ');
			message.params.push(rest);
		} else {
			if (m[3]) {
				message.params = m[3].split(' ');
			} else {
				message.params = [];
			}
		}
		if (m[2]) {
			message.command = m[2].toUpperCase();
		}
		if (m[1]) {
			message.sender = m[1];
		}
	}
	return message;
}

// Returns a number based on the discord server that increases per call.
// Used to make fairly sure nicknames on irc end up being unique after being scrubbed. 
// Make nicknames work for irc. 
function ircNickname(discordDisplayName, botuser, discriminator) {
	const replaceRegex = /[^a-zA-Z0-9_\\[\]\{\}\^`\|]/g;
	const shortenRegex = /_+/g;

	if (replaceRegex.test(discordDisplayName)) {

		let newDisplayname = `${discordDisplayName.replace(replaceRegex, '_')}${discriminator}`;
		newDisplayname = newDisplayname.replace(shortenRegex, '_');

		return botuser ? `${newDisplayname}[BOT]` : newDisplayname;

	} else {
		return botuser ? `${discordDisplayName}[BOT]` : discordDisplayName;
	}


}


// Parses discord lines to make them work better on irc. 
function parseDiscordLine(line, discordID) {
	// Discord markdown parsing the lazy way. Probably fails in a bunch of different ways but at least it is easy. 
	line = line.replace(/\*\*(.*?)\*\*/g, '\x02$1\x0F');
	line = line.replace(/\*(.*?)\*/g, '\x1D$1\x0F');
	line = line.replace(/^_(.*?)\_$/g, '\x01ACTION $1\x01');
	line = line.replace(/__(.*?)__/g, '\x1F$1\x0F');

	// With the above regex we might end up with to many end characters. This replaces the, 
	line = line.replace(/\x0F{2,}/g, '\x0F');

	// Now let's replace mentions with names we can recognize. 
	const mentionUserRegex = /(<@!?\d+?>)/g;
	const mentionUserFound = line.match(mentionUserRegex);

	if (mentionUserFound) {
		mentionUserFound.forEach(mention => {
			const userID = mention.replace(/<@!?(\d+?)>/, '$1');
			const memberObject = discordClient.guilds.get(discordID).members.get(userID);
			const displayName = memberObject.displayName;
			const isBot = memberObject.user.bot;
			const discriminator = memberObject.user.discriminator;

			const userName = ircNickname(displayName, isBot, discriminator);
			const replaceRegex = new RegExp(mention, 'g');
			if (userName) {
				line = line.replace(replaceRegex, `@${userName}`);
			}
		});
	}

	// Now let's do this again and replace mentions with roles we can recognize. 
	const mentionRoleRegex = /(<@&\d+?>)/g;
	const mentionRoleFound = line.match(mentionRoleRegex);
	if (mentionRoleFound) {
		mentionRoleFound.forEach(mention => {
			const roleID = mention.replace(/<@&(\d+?)>/, '$1');
			const roleObject = discordClient.guilds.get(discordID).roles.get(roleID);

			const replaceRegex = new RegExp(mention, 'g');
			if (roleObject) {
				const name = roleObject.name;
				line = line.replace(replaceRegex, `@${name}`);
			}
		});
	}

	// Channels are also a thing!. 
	const mentionChannelRegex = /(<#\d+?>)/g;
	const mentionChannelFound = line.match(mentionChannelRegex);
	if (mentionChannelFound) {
		mentionChannelFound.forEach(mention => {
			const channelID = mention.replace(/<#(\d+?)>/, '$1');
			const channelObject = discordClient.guilds.get(discordID).channels.get(channelID);

			const replaceRegex = new RegExp(mention, 'g');
			if (channelObject) {
				const name = channelObject.name;
				line = line.replace(replaceRegex, `#${name}`);
			}
		});
	}

	return line;
}

// Parse irc lines to make them work better on discord.
function parseIRCLine(line, discordID, channel) {
	line = line.replace(/\001ACTION(.*?)\001/g, '_$1_');

	// Discord-style username mentions (@User)
	const mentionDiscordRegex = /(@.+?\s)/g;
	const mentionDiscordFound = line.match(mentionDiscordRegex);
	if (mentionDiscordFound) {
		mentionDiscordFound.forEach(mention => {
			const userNickname = mention.replace(/@(.+?)\s/, '$1');

			if (ircDetails[discordID].channels[channel].members.hasOwnProperty(userNickname)) {
				const userID = ircDetails[discordID].channels[channel].members[userNickname].id;
				const replaceRegex = new RegExp(mention, 'g');

				line = line.replace(replaceRegex, `<@!${userID}> `);
			}
		});
	}

	// IRC-style username mentions (User: at the start of the line)
	const mentionIrcRegex = /(^.+?:)/g;
	const mentionIrcFound = line.match(mentionIrcRegex);
	if (mentionIrcFound) {
		mentionIrcFound.forEach(mention => {
			const userNickname = mention.replace(/^(.+?):/, '$1');

			if (ircDetails[discordID].channels[channel].members.hasOwnProperty(userNickname)) {
				const userID = ircDetails[discordID].channels[channel].members[userNickname].id;
				const replaceRegex = new RegExp(mention, 'g');

				line = line.replace(replaceRegex, `<@!${userID}>`);
			}
		});
	}

	// Channel names
	const mentionChannelRegex = /(#.+?\s)/g;
	const mentionChannelFound = line.match(mentionChannelRegex);
	if (mentionChannelFound) {
		mentionChannelFound.forEach(mention => {
			const channelName = mention.replace(/#(.+?)\s/, '$1');

			if (ircDetails[discordID].channels.hasOwnProperty(channelName)) {
				const userID = ircDetails[discordID].channels[channelName].id;
				const replaceRegex = new RegExp(mention, 'g');

				line = line.replace(replaceRegex, `<#${userID}> `);
			}
		});
	}

	return line;
}

const presenceDict = {
	'offline': 'Offline',
	'dnd': 'Do not disturb',
	'idle': 'Idle',
	'online': ''
}

// TODO Need to remove offline users if showOfflineUsers isn't set? idk
function sendPresenceUpdate(socket, identifier, presence) {
	if (socket.awayNotify && (status = presenceDict[presence]) != undefined)
		socket.deliver(identifier, 'AWAY', status || []);
}

//
// Discord related functionality.
//

// Create our discord client. 
let discordClient = new Discord.Client({
	fetchAllMembers: true,
	sync: true
});

// Log into discord using the token defined in config.js 
discordClient.login(configuration.discordToken);

//
// Various events used for debugging. 
//

// Will log discord debug information.
/*discordClient.on('debug', info => console.log('debug', info));*/

// When debugging we probably want to know about errors as well. 
discordClient.on('error', info => {
	console.log('error', info);
	sendGeneralNotice('Discord error.');
});

// Emitted when the Client tries to reconnect after being disconnected.
discordClient.on('reconnecting', () => {
	console.log('reconnecting');
	sendGeneralNotice('Reconnecting to Discord.');
});

// Emitted whenever the client websocket is disconnected.
discordClient.on('disconnect', event => {
	console.log('disconnected', event);
	sendGeneralNotice('Discord has been disconnected.');
});

// Emitted for general warnings.
discordClient.on('warn', info => console.log('warn', info));

// Discord is ready. 
discordClient.on('ready', () => {
	// This is probably not needed, but since sometimes things are weird with discord.
	discordClient.guilds.array().forEach(guild => {
		guild.fetchMembers();
		guild.sync();
	});

	console.log(`Logged in as ${discordClient.user.username}!`);

	// Lets grab some basic information we will need eventually. 
	// But only do so if this is the first time connecting. 
	if (discordFirstConnection) {
		discordFirstConnection = false;

		discordClient.guilds.array().forEach(guild => {
			const guildID = guild.id;
			if (!ircDetails.hasOwnProperty(guildID)) {
				ircDetails[guildID] = {
					lastPRIVMSG: [],
					channels: {},
					members: {}
				};
			}

			guild.members.array().forEach(member => {
				const ircDisplayName = ircNickname(member.displayName, member.user.bot, member.user.discriminator);
				ircDetails[guildID].members[ircDisplayName] = member.id;
			});


		});
		discordClient.channels.array().forEach(channel => {
			// Of course only for channels. 
			if (channel.type === 'text') {
				const guildID = channel.guild.id,
					channelName = channel.name,
					channelID = channel.id,
					channelTopic = channel.topic || 'No topic';


				ircDetails[guildID].channels[channelName] = {
					id: channelID,
					joined: [],
					topic: channelTopic
				};
			}
		});



		// Now that is done we can start the irc server side of things. 
		ircServer.listen(configuration.ircServer.listenPort);
	} else {
		sendGeneralNotice('Discord connection has been restored.');
	}
});

//
// Acting on events
//

// There are multiple events that indicate a users is no longer on the server. 
// We abuse the irc QUIT: message for this even if people are banned. 
function guildMemberNoMore(guildID, ircDisplayName, noMoreReason) {
	let found = false;
	// First we go over the channels. 
	for (let channel in ircDetails[guildID].channels) {
		if (ircDetails[guildID].channels.hasOwnProperty(channel) && ircDetails[guildID].channels[channel].joined.length > 0) {

			let channelMembers = ircDetails[guildID].channels[channel].members;
			// Within the channels we go over the members. 
			if (channelMembers.hasOwnProperty(ircDisplayName)) {
				if (!found) {
					let memberDetails = ircDetails[guildID].channels[channel].members[ircDisplayName];
					console.log(`User ${ircDisplayName} quit ${noMoreReason}`);
					ircDetails[guildID].channels[channel].joined.forEach(socketID => getSocketDetails(socketID).deliver(ircDisplayName + '!' + memberDetails.id + '@void', 'QUIT', noMoreReason));
					found = true;
				}
				delete ircDetails[guildID].channels[channel].members[ircDisplayName];
			}
		}
	}

	if (noMoreReason !== 'User gone offline') {
		delete ircDetails[guildID].members[ircDisplayName];
	}
}

function guildMemberCheckChannels(guildID, ircDisplayName, guildMember) {
	// First we go over the channels. 
	for (let channel in ircDetails[guildID].channels) {
		if (ircDetails[guildID].channels.hasOwnProperty(channel) && ircDetails[guildID].channels[channel].joined.length > 0) {
			let isInDiscordChannel = false;
			let isCurrentlyInIRC = false;

			let channelDetails = ircDetails[guildID].channels[channel];
			let channelMembers = channelDetails.members;
			let channelID = channelDetails.id;

			//Let's check the discord channel. 
			let discordMemberArray = discordClient.guilds.get(guildID).channels.get(channelID).members.array();
			discordMemberArray.forEach(discordMember => {
				if (guildMember.displayName === discordMember.displayName && (guildMember.presence.status !== 'offline' || configuration.showOfflineUsers)) {
					isInDiscordChannel = true;
				}
			});

			// Within the channels we go over the members. 
			if (channelMembers.hasOwnProperty(ircDisplayName)) {
				// User found for channel. 
				isCurrentlyInIRC = true;
			}

			// If the user is in the discord channel but not irc we will add the user. 
			if (!isCurrentlyInIRC && isInDiscordChannel) {
				ircDetails[guildID].channels[channel].members[ircDisplayName] = {
					discordName: guildMember.displayName,
					discordState: guildMember.presence.status,
					ircNick: ircDisplayName,
					id: guildMember.id
				};

				console.log(`User ${ircDisplayName} joined ${channel}`);
				ircDetails[guildID].channels[channel].joined.forEach(socketID => {
					const socket = getSocketDetails(socketID);

					socket.deliver(ircDisplayName + '!' + guildMember.id + '@void', 'JOIN', '#' + channel);
					sendPresenceUpdate(socket, ircDisplayName + '!' + guildMember.id + '@void', guildMember.presence);
				});
			}

			// If the user is currently in irc but not in the discord channel they have left the channel. 
			if (isCurrentlyInIRC && !isInDiscordChannel) {
				ircDetails[guildID].channels[channel].joined.forEach(socketID => {
					const socket = getSocket
					console.log(`User ${ircDisplayName} left ${channel}`);
					getSocketDetails(socketID).deliver(ircDisplayName + '!' + guildMember.id + '@void', 'PART',  '#' + channel);
					delete ircDetails[guildID].channels[channel].members[ircDisplayName];
				});
			}

		}
	}
}

function guildMemberNickChange(guildID, oldIrcDisplayName, newIrcDisplayName, newDiscordDisplayName) {
	// First we go over the channels. 
	let foundInChannels = false;
	let memberId;

	ircDetails[guildID].members[newIrcDisplayName] = ircDetails[guildID].members[oldIrcDisplayName];
	delete ircDetails[guildID].members[oldIrcDisplayName];

	for (let channel in ircDetails[guildID].channels) {
		if (ircDetails[guildID].channels.hasOwnProperty(channel) && ircDetails[guildID].channels[channel].joined.length) {

			let channelDetails = ircDetails[guildID].channels[channel];
			let channelMembers = channelDetails.members;

			// Within the channels we go over the members. 
			if (channelMembers.hasOwnProperty(oldIrcDisplayName)) {
				let tempMember = channelMembers[oldIrcDisplayName];
				tempMember.displayName = newDiscordDisplayName;
				tempMember.ircNick = newIrcDisplayName;
				memberId = tempMember.id;
				delete ircDetails[guildID].channels[channel].members[oldIrcDisplayName];
				ircDetails[guildID].channels[channel].members[oldIrcDisplayName] = tempMember;

				ircDetails[guildID].channels[channel].joined.forEach(socketID => getSocketDetails(socketID).deliver(oldIrcDisplayName + '!' + memberId + '@void', 'NICK', newIrcDisplayName));
			}
		}
	}
}

discordClient.on('guildMemberRemove', GuildMember => {
	if (ircClients.length) {
		console.log('guildMemberRemove');
		const guildID = GuildMember.guild.id;
		const isBot = GuildMember.user.bot;
		const discriminator = GuildMember.user.discriminator;

		const ircDisplayName = ircNickname(GuildMember.displayName, isBot, discriminator);
		guildMemberNoMore(guildID, ircDisplayName, 'User removed');
	}
});

discordClient.on('presenceUpdate', (oldMember, newMember) => {
	if (ircClients.length) {
		const guildID = newMember.guild.id;
		const isBot = newMember.user.bot;
		const discriminator = newMember.user.discriminator;

		const ircDisplayName = ircNickname(newMember.displayName, isBot, discriminator);
		const oldPresenceState = oldMember.presence.status;
		const newPresenceState = newMember.presence.status;

		if (oldPresenceState === 'offline' && !configuration.showOfflineUsers)
			guildMemberCheckChannels(guildID, ircDisplayName, newMember);
		else if (newPresenceState === 'offline' && !configuration.showOfflineUsers)
			guildMemberNoMore(guildID, ircDisplayName, 'User gone offline');
		else if (configuration.showOfflineUsers)
			ircClients.filter(socket => socket.discordid == guildID)
				.forEach(socket => sendPresenceUpdate(socket, ircDisplayName + '!' + newMember.id + '@void', newPresenceState));
	}
});

discordClient.on('guildMemberUpdate', (oldMember, newMember) => {
	if (ircClients.length) {
		console.log('guildMemberUpdate');
		const guildID = newMember.guild.id;
		const oldIsBot = oldMember.user.bot;
		const newIsBot = newMember.user.bot;
		const discriminator = newMember.user.discriminator;
		const oldIrcDisplayName = ircNickname(oldMember.displayName, oldIsBot, discriminator);
		const newIrcDisplayName = ircNickname(newMember.displayName, newIsBot, discriminator);
		const newDiscordDisplayName = newMember.displayName;

		if (oldIrcDisplayName !== newIrcDisplayName)
			if (newMember.id === discordClient.user.id)
				ircClients.filter(socket => socket.discordid == guildID)
					.forEach(socket => socket.deliver(oldIrcDisplayName + '!' + discordClient.user.id + '@void', 'NICK', [newIrcDisplayName]));
			else
				guildMemberNickChange(guildID, oldIrcDisplayName, newIrcDisplayName, newDiscordDisplayName);
		else
			guildMemberCheckChannels(guildID, newIrcDisplayName, newMember);
	}
});

discordClient.on('guildMemberAdd', GuildMember => {
	if (ircClients.length > 0) {
		console.log('guildMemberAdd');
		const guildID = GuildMember.guild.id;
		const isBot = GuildMember.user.bot;
		const discriminator = GuildMember.user.discriminator;
		const ircDisplayName = ircNickname(GuildMember.displayName, isBot, discriminator);
		guildMemberCheckChannels(guildID, ircDisplayName, GuildMember);
	}
});

discordClient.on('channelCreate', newChannel => {
	if (newChannel.type === 'text') {
		const discordServerId = newChannel.guild.id;
		ircDetails[discordServerId].channels[newChannel.name] = {
			id: newChannel.id,
			members: {},
			topic: newChannel.topic || 'No topic',
			joined: []
		};
	}
});

discordClient.on('channelDelete', deletedChannel => {
	if (deletedChannel.type === 'text') {
		const discordServerId = deletedChannel.guild.id;
		if (ircDetails[discordServerId].channels[deletedChannel.name].joined.length) {
			// First we inform the user in the old channelContent
			ircDetails[discordServerId].channels[deletedChannel.name].joined.forEach(socketID => {
				const socket = getSocketDetails(socketID);
				socket.deliver('discordIRCd!unknown@void', 'PRIVMSG', ['#' + deletedChannel.name, deletedChannel.name + ' has been deleted']);
				partCommand(deletedChannel.name, discordServerId, socket);
			});
		}

		// Finally remove the channel from the list. 
		delete ircDetails[discordServerId].channels[deletedChannel.name];
	}
});

discordClient.on('channelUpdate', (oldChannel, newChannel) => {
	const discordServerId = oldChannel.guild.id;
	console.log('channel updated');
	if (oldChannel.type === 'text') {

		if (oldChannel.name !== newChannel.name) {
			console.log(`channel name changed from #${oldChannel.name} to #${newChannel.name}`);
			ircDetails[discordServerId].channels[newChannel.name] = {
				id: newChannel.id,
				members: {},
				topic: newChannel.topic || 'No topic',
				joined: []
			};

			ircDetails[discordServerId].channels[oldChannel.name].joined.forEach(socketID => {
				const socket = getSocketDetails(socketID);

				socket.deliver('discordIRCd!unknown@void', 'PRIVMSG', ['#' + oldChannel.name, `#${oldChannel.name} has been renamed to #${newChannel.name}`]);

				// First we inform the user in the old channelContent
				partCommand(oldChannel.name, discordServerId, socket);
				joinCommand(newChannel.name, discordServerId, socket);
			});

			// Delete the old one.
			delete ircDetails[discordServerId].channels[oldChannel.name];
		}
	}

	// Simple topic change. 
	if (oldChannel.topic !== newChannel.topic)
		ircClients.filter(socket => socket.discordid === discordServerId && ircDetails[discordServerId].channels[newChannel.name].joined.indexOf(socket.ircid) > -1)
			.forEach(socket => socket.deliver('discordIRCd', 'TOPIC', ['#' + newChannel.name, newChannel.topic || 'No topic']));
});

let msgHandler;

// Processing received messages 
discordClient.on('message', msgHandler = msg => {
	if (ircClients.length > 0 && msg.channel.type === 'text') {


		const discordServerId = msg.guild.id;

		// Webhooks don't have a member.
		let authorDisplayName;

		if (msg.member) {
			authorDisplayName = msg.member.displayName;
		} else {
			authorDisplayName = msg.author.username;
		}
		const authorIrcName = ircNickname(authorDisplayName, msg.author.bot, msg.author.discriminator);
		const channelName = msg.channel.name;

		// Doesn't really matter socket we pick this from as long as it is connected to the discord server.
		let ownNickname = getSocketDetails(ircDetails[discordServerId].channels[channelName].joined[0]).nickname;

		let messageContent = msg.content;

		if (configuration.handleCode) {
			const codeRegex = /```(.*?)\r?\n([\s\S]*?)```/;
			const replaceRegex = /```.*?\r?\n[\s\S]*?```/;

			if (codeRegex.test(messageContent)) {
				const codeDetails = messageContent.match(codeRegex);

				// In the future I want to include the url in the message. But since the call to gist is async that doesn't fit the current structure. 
				messageContent = messageContent.replace(replaceRegex, '');
				let extension;
				let language;
				if (codeDetails[1]) {
					language = codeDetails[1].toLowerCase();
					extension = (lang = langs.indexOf(language)) > -1 ? langExts[lang] || language : language;
				} else {
					extension = 'txt';
					language = 'unknown';
				}

				const fileName = authorIrcName + '_code_' + Math.random().toString(36).substring(7) + '.' + extension;

				if (codeCache.length >= configuration.attachmentServer.cacheSize)
					codeCache.pop();
				codeCache[fileName] = codeDetails[2];

				ircDetails[discordServerId].channels[channelName].joined.forEach(socketID => getSocketDetails(socketID).deliver(authorIrcName + '!' + msg.author.id + '@void', 'PRIVMSG', ['#' + channelName, `http://${configuration.attachmentServer.hostname}:${configuration.attachmentServer.listenPort}/${fileName}`]));
			}
		}

		let memberMentioned = false;
		let memberDirectlyMentioned = false;

		const ownGuildMember = discordClient.guilds.get(discordServerId).members.get(discordClient.user.id);

		if (msg.mentions.roles.array().length > 0) {
			ownGuildMember.roles.array().forEach(role => {
				if (msg.isMentioned(role)) {
					memberMentioned = true;
				}
			});

		}

		if (msg.mentions.everyone) {
			memberMentioned = true;
		}

		// Only add it if the nickname is known. If it is undefined the client is not in the channel and will be notified through PM anyway.
		if (memberMentioned && ownNickname) {
			messageContent = `${ownNickname}: ${messageContent}`;
		}

		if (msg.mentions.users.array().length) {
			if (msg.isMentioned(ownGuildMember)) {
				memberDirectlyMentioned = true;
			}
		}

		// Only act on text channels and if the user has joined them in irc or if the user is mentioned in some capacity. 
		if (ircDetails[discordServerId].channels[channelName].joined.length || memberMentioned || memberDirectlyMentioned) {

			// IRC does not handle newlines. So we split the message up per line and send them seperatly.
			const messageArray = messageContent.split(/\r?\n/);

			msg.attachments.array().forEach(attachment => messageArray.push(attachment.filename + ': ' + (shorten ? shorten(attachment.url) : attachment.url)));

			messageArray.forEach(line => {
				const remainingLength = maxLineLength - channelName.length - 13;

				const matchRegex = new RegExp(`[\\s\\S]{1,${remainingLength}}`, 'g');

				const linesArray = line.match(matchRegex) || [];

				linesArray.forEach(sendLine => {
					// Trying to prevent messages from irc echoing back and showing twice.
					if (ircDetails[discordServerId].lastPRIVMSG.indexOf(sendLine) < 0) {
						const message = parseDiscordLine(sendLine, discordServerId);

						ircDetails[discordServerId].channels[channelName].joined.forEach(socketID => getSocketDetails(socketID).deliver(authorIrcName + '!' + msg.author.id + '@void', 'PRIVMSG', ['#' + channelName, message]));

						// Let's make people aware they are mentioned in channels they are not in. 
						if (memberMentioned || memberDirectlyMentioned)
							ircClients.filter(socket => socket.discordid === discordServerId && ircDetails[discordServerId].channels[channelName].joined.indexOf(socket.ircid) === -1)
								.forEach(socket => socket.deliver('discordIRCd!unknown@void', 'PRIVMSG', ['discordIRCd', `#${channelName}: <${authorDisplayName}> ${lineToSend}`]));

					}
				});
			});
		}
	}
	if (ircClients.length && msg.channel.type === 'dm') {
		const discordServerId = 'DMserver';
		const authorDisplayName = msg.author.username;
		const authorIsBot = msg.author.bot;
		const authorDiscriminator = msg.author.discriminator;
		const authorIrcName = ircNickname(authorDisplayName, authorIsBot, authorDiscriminator);

		const recipientIsBot = msg.channel.recipient.bot;
		const recipientDiscriminator = msg.channel.recipient.discriminator;
		const recipient = ircNickname(msg.channel.recipient.username, recipientIsBot, recipientDiscriminator);

		const dmSocket = ircClients.find(socket => socket.discordid === discordServerId);

		// Can't handle dm, not connected to DMserver
		if (!dmSocket)
			return;

		const sender = authorIrcName === dmSocket.nickname ? recipient : dmSocket.nickname;

		// IRC does not handle newlines. So we split the message up per line and send them seperatly.
		const messageArray = msg.content.split(/\r?\n/);

		messageArray.forEach(line => {
			const remainingLength = maxLineLength - sender.length - 11;

			const matchRegex = new RegExp(`[\\s\\S]{1,${remainingLength}}`, 'g');

			const linesArray = line.match(matchRegex) || [];

			linesArray.forEach(sendLine => {
				// Trying to prevent messages from irc echoing back and showing twice.
				if (ircDetails[discordServerId].lastPRIVMSG.indexOf(sendLine) < 0) {
					const message = parseDiscordLine(sendLine, discordServerId);
					dmSocket.deliver(authorIrcName + '!' + msg.author.id + '@void', 'PRIVMSG', [sender, message]);
				}
			});
		});

		msg.attachments.array().forEach(attachment => dmSocket.deliver(authorIrcName + '!' + msg.author.id + '@void', 'PRIVMSG', [sender, attachment.filename + ': ' + (shorten ? shorten(attachment.url) : attachment.url)]));
	}
});

discordClient.on('messageUpdate', (_, msg) => {
	if (msg.content.startsWith('[EDIT] '))
		return;
	msg.content = '[EDIT] ' + msg.content;
	msgHandler(msg);
});

// TODO Message Embed handling & URL extraction

// Join command given, let's join the channel. 
function joinCommand(channel, discordID, socket) {
	let members = '';
	let memberListLines = [];
	const nickname = ircDetails[discordID].ircDisplayName;
	const memberlistTemplate = `:${configuration.ircServer.hostname} 353 ${nickname} @ #${channel} :`;
	const memberlistTemplateLength = memberlistTemplate.length;

	if (ircDetails[discordID].channels.hasOwnProperty(channel)) {
		const channelProperties = ircDetails[discordID].channels[channel];
		const channelContent = discordClient.channels.get(channelProperties.id);

		ircDetails[discordID].channels[channel].joined.push(socket.ircid);
		ircDetails[discordID].channels[channel]['members'] = {};
		const channelTopic = channelProperties.topic;

		channelContent.members.array().forEach(member => {
			const isBot = member.user.bot;
			const discriminator = member.user.discriminator;
			const displayMember = ircNickname(member.displayName, isBot, discriminator);

			if (member.presence.status === 'online' ||
				member.presence.status === 'idle' ||
				member.presence.status === 'dnd' ||
				(member.presence.status === 'offline' && configuration.showOfflineUsers)) {

				ircDetails[discordID].channels[channel].members[displayMember] = {
					discordName: member.displayName,
					discordState: member.presence.status,
					ircNick: displayMember,
					id: member.id
				};
				const membersPlusDisplayMember = members ? `${members} ${displayMember}` : displayMember
				const newLineLength = membersPlusDisplayMember.length;
				const combinedLineLength = newLineLength + memberlistTemplateLength;

				if (combinedLineLength < maxLineLength) {
					members = membersPlusDisplayMember;
				} else {
					memberListLines.push(members);
					members = displayMember;
				}
			}
		});

		memberListLines.push(members);

		socket.deliver(nickname, 'JOIN', '#' + channel);

		// Setting the topic.
		socket.deliver('discordIRCd', 332, [nickname, '#' + channel, channelTopic]);

		// TODO topic atime
		//const todayDate = new Date();
		//const seconds = todayDate.getTime() / 1000;
		//const topicMSG2 = `:${configuration.ircServer.hostname} 333 ${nickname} #${channel} noboyknows!orCares@void ${seconds}\r\n`;
		//sendToIRC(discordID, topicMSG2, socket.ircid);

		memberListLines.forEach(line => socket.deliver('discordIRCd', 353, [nickname, '@', '#' + channel, line]));

		socket.deliver('discordIRCd', 366, [nickname, '#' + channel, 'End of /NAMES list.']);

		if (socket.awayNotify) {
			for (const key in ircDetails[discordID].channels[channel].members) {
				if (ircDetails[discordID].channels[channel].members.hasOwnProperty(key)) {
					const member = ircDetails[discordID].channels[channel].members[key];
					sendPresenceUpdate(socket, member.ircNick + '!' + newMember.id + '@void', 'AWAY', member.discordStatus);
				}
			}
		}

		// If the amount of messages to be fetched after joining is set to 0,
		// then we just exit the function here. Nothing, besides fetching the
		// messages, happens after here, so it's okay
		const messageLimit = configuration.discord.messageLimit;
		if (messageLimit === 0) return;
		
		// Fetch the last n Messages
		channelContent.fetchMessages({limit: messageLimit}).then(messages => {
			console.log(`Fetched messages for "${channel}"`);
			// For some reason the messages are not ordered. So we need to sort
			// them by creation date before we do anything.
			messages.array().sort((msgA, msgB) => {
				return msgA.createdAt - msgB.createdAt;
			}).forEach(msg => {
				// We check if the message we're about to send has more than 1 line.
				// If it does, then we need to send them one by one. Otherwise the client
				// will try to interpret them as commands.
				const lines = msg.cleanContent.split(/\r?\n/);
				const authorIrcName = ircNickname(msg.author.username, msg.author.bot, msg.author.discriminator);
				if (lines.length > 1)
					lines.forEach(line => socket.deliver(authorIrcName + '!discordIRCd', 'PRIVMSG', ['#' + channel, line]));
				else
					socket.deliver(authorIrcName + '!discordIRCd', 'PRIVMSG', ['#' + channel, msg.cleanContent]);
			});
		});

	} else
		socket.deliver('discordIRCd', 473, [nickname, '#' + channel, 'Cannot join channel']);
}

// Part command given, let's part the channel. 
function partCommand(channel, discordID, socket) {
	const nickname = ircDetails[discordID].ircDisplayName;
	if (ircDetails[discordID].channels.hasOwnProperty(channel)) {
		// Let's clear the channel
		const socketIndex = ircDetails[discordID].channels[channel].joined.indexOf(socket.ircid);
		if (socketIndex > -1)
			ircDetails[discordID].channels[channel].joined.splice(socketIndex, 1);

		// If no other sockets are connected we clear the channel.
		if (ircDetails[discordID].channels[channel].joined.length === 0)
			ircDetails[discordID].channels[channel].members = {};

		socket.deliver(nickname + '!' + discordClient.user.id + '@void', 'PART', '#' + channel);
	}
}

function getDiscordUserFromIRC(recipient, discordID) {
	let returnmember;

	if (discordID === 'DMserver') {
		discordClient.users.array().forEach(user => {
			const isBot = user.bot;
			const discriminator = user.discriminator;
			const displayMember = ircNickname(user.username, isBot, discriminator);

			if (displayMember === recipient) {
				returnmember = user;
			}
		});
	} else {
		discordClient.guilds.get(discordID).members.array().forEach(member => {
			const isBot = member.user.bot;
			const discriminator = member.user.discriminator;
			const displayMember = ircNickname(member.displayName, isBot, discriminator);

			if (displayMember === recipient) {
				returnmember = member;
			}
		});
	}
	return returnmember;
}

//
// IRC related functionality.
//

const capCommands = {
	ls: socket => {
		socket.isCAPBlocked = true;
		socket.deliver('discordIRCd', 'CAP', [socket.nickname, 'LS', 'away-notify']);
	},
	list: socket => {
		capArgs = [socket.nickname, 'LIST'];
		if (socket.awayNotify)
			capArgs.push('away-notify');
		socket.deliver('discordIRCd', 'CAP', capArgs);
	},
	ack: socket => {},
	end: socket => {
		socket.isCAPBlocked = false;
		if (socket.connectArray)
			socket.connectArray(socket);
		socket.connectArray = undefined;
	}
}

const registerCommands = {
	user: (socket, args) => {
		const username = args[0], altusername = args[3];

		if (username !== configuration.ircServer.username || altusername !== configuration.ircServer.username) {
			socket.deliver('discordIRCd', 464, [socket.nickname, 'Invalid username']);
			socket.end();
			return;
		}

		if (!socket.discordid) {
			socket.deliver('discordIRCd', 464, [socket.nickname, 'A password (guild ID) is required']);
			socket.end();
			return;
		}

		if (ircClients.find(iSocket => iSocket != socket && iSocket.discordid == socket.discordid)) {
			socket.deliver('discordIRC', 464, [socket.nickname, 'Already connected to this guild.']);
			socket.end();
			return;
		}

		socket.user = username;

		if (socket.discordid === 'DMserver') {
			const newuser = discordClient.user.username;
			const discriminator = discordClient.user.discriminator;
			const newNickname = ircNickname(newuser, false, discriminator);

			socket.identifier = `${socket.nickname}!${discordClient.user.id}@void`;

			ircDetails[socket.discordid]['discordDisplayName'] = newuser;
			ircDetails[socket.discordid]['ircDisplayName'] = newNickname;

			socket.user = newuser;
			socket.nickname = newNickname;
			socket.authenticated = true;

			socket.deliver(socket.identifier, 'NICK', [socket.nickname]);
			socket.deliver('discordIRCd', '001', [socket.nickname, 'Welcome to discordIRCd\'s bridge server']);
			socket.deliver('discordIRCd', '002', [socket.nickname, 'This server doesn\'t exist outside of the void.']);

			registerCommands.motd(socket);

		} else if (discordClient.guilds.get(socket.discordid)) {
			discordClient.guilds.get(socket.discordid).fetchMember(discordClient.user.id).then(guildMember => {
				const newuser = guildMember.displayName;
				const discriminator = discordClient.user.discriminator;
				const newNickname = ircNickname(newuser, false, discriminator);

				ircDetails[socket.discordid]['discordDisplayName'] = newuser;
				ircDetails[socket.discordid]['ircDisplayName'] = newNickname;

				socket.user = newuser;
				socket.nickname = newNickname;
				socket.authenticated = true;

				const connectArray = socket => {
					socket.deliver(socket.identifier, 'NICK', [socket.nickname]);
					socket.deliver('discordIRCd', '001', [socket.nickname, 'Welcome to discordIRCd\'s bridge server']);
					socket.deliver('discordIRCd', '002', [socket.nickname, 'This server doesn\'t exist outside of the void.']);
				};


				if (socket.isCAPBlocked) {
					socket.connectArray = connectArray;
				} else {
					connectArray(socket);
				}

				registerCommands.motd(socket);
			});
		} else {
			// Couldn't resolve guild ID
			socket.deliver('discordIRCd', 464, [socket.nickname, `Failed to find ${socket.discordid}`]);
			socket.end();
		}
	},
	pass: (socket, args) => {
		socket.discordid = args[0];
	},
	nick: (socket, args) => {
		socket.nickname = args[0];
	},
	motd: socket => {
		socket.deliver('discordIRCd', 375, [socket.nickname, '- discordIRCd Message of the Day -']);
		socket.deliver('discordIRCd', 372, [socket.nickname, '- Hello that one guy who has his IRC setup the perfect way -']);
		socket.deliver('discordIRCd', 376, [socket.nickname, 'End of /MOTD command.']);
	}
}

const commands = {
	join: (socket, args) => {
		const joinChannels = args[0].split(',');
		joinChannels.forEach(channel => joinCommand(channel.substring(1), socket.discordid, socket));
	},
	part: (socket, args) => {
		const partChannels = args[0].split(',');
		partChannels.forEach(channel => partCommand(channel.substring(1), socket.discordid, socket));
	},
	privmsg: (socket, args) => {
		let recipients = [];

		if (args[0])
			recipients = args[0].split(',');
		else {
			socket.deliver('discordIRCd', 411, [socket.nickname, 'No recipient given (PRIVMSG)']);
			return;
		}

		if (!args[1]) {
			socket.deliver('discordIRCd', 412, [socket.nickname, 'No message']);
			return;
		}

		recipients.forEach(recipient => {
			if (recipient.startsWith('#')) {
				const channelName = recipient.substring(1).toLowerCase();
				const sendLine = parseIRCLine(args[1], socket.discordid, channelName);

				if (ircDetails[socket.discordid].lastPRIVMSG.length > 3) {
					ircDetails[socket.discordid].lastPRIVMSG.shift();
				}

				ircDetails[socket.discordid].lastPRIVMSG.push(sendLine.trim());
				const channels = ircDetails[socket.discordid].channels;
				discordClient.channels.get(channels[channelName].id).send(sendLine);
			} else if (recipient !== 'discordIRCd') {
				const recipientUser = getDiscordUserFromIRC(recipient, socket.discordid);

				// User doesn't exist
				if (!recipientUser) {
					socket.deliver('discordIRCd', 464, [socket.nickname, 'Couldn\'t find recipient']);
					return;
				}

				const message = args[1];
				recipientUser.send(message);

				ircDetails[socket.discordid].lastPRIVMSG.push(message.trim());
				if (ircDetails[socket.discordid].lastPRIVMSG.length > 3)
					ircDetails[socket.discordid].lastPRIVMSG.shift();

				if (socket.discordid !== 'DMserver')
					socket.deliver(socket.identifier, 'PRIVMSG', [recipient, 'PM Send: Note that the replies will not arrive here but on the PM server']);

				if (ircDetails[socket.discordid].lastPRIVMSG.length > 3)
					ircDetails[socket.discordid].lastPRIVMSG.shift();
			}
		});

	},
	quit: socket => {
		ircDetails[socket.discordid].channels.foreach(channel => {
			if (ircDetails[socket.discordid].channels.hasOwnProperty(channel)) {
				const socketIndex = channel.joined.indexOf(socket.ircid);
				if (socketIndex > 0)
					channel.joined.splice(socketIndex, 1);
			}
		});
	},
	list: socket => {
		if (socket.discordid === 'DMserver')
			return;

		const nickname = ircDetails[socket.discordid].ircDisplayName;
		const channels = discordClient.guilds.get(socket.discordid).channels.array();
		socket.deliver('discordIRCd', 321, [socket.nickname, 'Channel', 'Users Name']);

		channels.forEach(channel => {
			if (channel.type === 'text') {
				const channelname = channel.name,
					memberCount = channel.members.array().length,
					channeltopic = channel.topic;

				socket.deliver('discordIRCd', 322, [socket.nickname, '#' + channelname, memberCount, channeltopic]);
			}
		});

		socket.deliver('discordIRCd', 323, [socket.nickname, 'End of channel list.']);
	},
	ping: socket => {
		socket.deliver('discordIRCd', 'PONG', ['discordIRCd', socket.pongcount++]);
	},
	whois: (socket, args) => {
		const whoisUser = args[0].trim();
		const userID = ircDetails[socket.discordid].members[whoisUser];
		// TODO
	}
}

let ircServer = net.createServer(netOptions, socket => {
	console.log(socket.remoteAddress, 'connected');
	socket.setEncoding('utf8');

	ircClients.push(socket);

	socket.ircid = ircClientCount++;
	socket.discordid = '';
	socket.nickname = '*';
	socket.user = '';
	socket.pongcount = 1;
	socket.isCAPBlocked = false;
	socket.authenticated = false;
	socket.connectArray = undefined;
	socket.awayNotify = false;
	socket.identifier = '';

	socket.on('error', error => {
		console.log('Socket error: ', error);
		socket.end();
	});

	socket.on('data', data => {
		console.log(socket.nickname, '>>>', data);
		// Data can be multiple lines. Here we put each line in an array. 
		let dataArray = data.match(/.+/g);
		dataArray.forEach(line => {
			let parsedLine = parseMessage(line);

			if (parsedLine.command.toLowerCase() == "cap") {
				const command = capCommands[parsedLine.params[0].toLowerCase()];
				if (command)
					command(socket);
				else
					socket.deliver('discordIRCd', 410, [socket.nickname, args[0], 'Invalid CAP command']);
				return;
			}

			if (!socket.isCAPBlocked || !socket.authenticated) {
				const command = (socket.authenticated ? commands : registerCommands)[parsedLine.command.toLowerCase()];
				if (command) {
					try {
						command(socket, parsedLine.params);
					} catch (err) {
						console.log('Command processing error', err);
					}
				} else
					socket.deliver('discordIRCd', 421, [socket.nickname, parsedLine.command, 'Unknown command']);
			}
		});
	});


	// When a client is ended we remove it from the list of clients. 
	socket.on('end', () => ircClients.splice(ircClients.indexOf(socket), 1));

	if (socket instanceof net.Stream) {
		socket.deliver = (from, command, args) => {
			let out = '', lastArg;

			if (!Array.isArray(args))
				args = [args];

			try {
				if (from)
					out += ':' + from + ' ';

				out += command.toString().toUpperCase();

				if (args.length) {
					lastArg = args.pop();

					if (args.length)
						out += ' ' + args.join(' ');

					// kinda fucky wucky
					out += (!args.length && lastArg.startsWith('#') ? ' ' : ' :') + lastArg;
				}

				console.log(socket.nickname, "<<<", out);
				socket.write(out + '\r\n');
			} catch (err) {
				console.log(socket.remoteAddress, socket.nickname, err);
			}
		}
	}
});

function getSocketDetails(socketID) {
	let socketDetails = {};

	ircClients.forEach(socket => {
		if (socket.ircid === socketID) {
			socketDetails = {
				ircid: socket.ircid,
				discordid: socket.discordid,
				nickname: socket.nickname,
				user: socket.user,
				isCAPBlocked: socket.isCAPBlocked,
				authenticated: socket.authenticated,
				awayNotify: socket.awayNotify,
				identifier: socket.identifier,
				deliver: socket.deliver
			};
		}
	});

	return socketDetails;
}

// Sending notices to all connected clients.
function sendGeneralNotice(noticeText) {
	ircClients.forEach(socket => {
		const notice = `:${configuration.ircServer.hostname} NOTICE ${socket.nickname} :${noticeText}\r\n`;
		socket.write(notice);
	});
}


// We want to be able to kill the process without having to deal with leftover connections.
process.on('SIGINT', () => {
	console.log('\nGracefully shutting down from SIGINT (Ctrl-C)');
	sendGeneralNotice('IRC server has been shut down through SIGINT');
	ircClients.forEach(socket => socket.end());
	discordClient.destroy();
	ircServer.close();
	process.exit();
});
