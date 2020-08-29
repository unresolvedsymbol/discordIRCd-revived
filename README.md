# discordIRCd revived
discordIRCd revived is a node.js application that allows you to connect to discord with your irc client.
I started to revive this project due to there being no open source alternative to the official Discord client on Android, therefore I opted to use something like this with MrARM's Revolution IRC.
However, the original source code being old and unmaintained seemed to make Revolution IRC crash instantly after joining.
I refactored a good portion of the IRC server side. Although it's still a single clunky file, I don't really plan on changing that due to how simple it is. There is some slimming down to be done though.

![I really like the way I have it set up!](https://imgs.xkcd.com/comics/team_chat.png)  
https://xkcd.com/1782/

## Usage 

- Run `NPM install`
- Edit config.js to your personal preferences. Your Discord token can be aquired by going into your browsers developer tools and grabbing it from localstorage there. 
- Start the server through server.js 
- Connect with your ircclient to the server at the given adress with the following details: 
    - Username: The username defined in config.js, basically acts as a password. 
    - Server password: The id of the discord server you want to connect to. 
- Join the channels you want.

### Sending and receiving private messages. 
Discord doesn't send private messages based on the server. In order to work around that discordIRCd provides an extra server that is soley used for sending and receiving private messages. To join it it use the server password `DMserver`. 

Private conversations can be initiated from any server but will be automatically taken up by the private message server. 

## Features

- Users joining/leaving channels and servers. 
- Away for idle, DnD, and offline discord users. 
- Mentions are translated both ways. 
- Basic discord markdown is parsed to irc formatting. 
- Built in web server for attachment URL shortening and code downloads (experimental) 
- Message edit detection
### TODO
- Selfbot-like commands for editing, reacting, and deleting messages
