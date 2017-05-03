/**
 * @typedef {Discord.Client} SharpCore
 * @property {Object} config The bot config
 * @prop {Object} logger The bot's logger
 */


'use strict';
const Managers = require('./managers');

const Discord = require('discord.js');
const fse = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const XPDB = require('xpdb');

const stripIndents = require('common-tags').stripIndents;

const bot = exports.client = new Discord.Client();

const logger = bot.logger = new Managers.Logger(bot);
logger.inject();

let dataFolder = path.join(__dirname, '../data/');
if (!fse.existsSync(dataFolder)) fse.mkdirSync(dataFolder);
bot.db = new XPDB(dataFolder);

const commands = bot.commands = new Managers.CommandManager(bot);
const stats = bot.stats = new Managers.Stats(bot);

try {
    bot.config = fse.readJsonSync(path.join(__dirname, '../config.json'));
} catch (err) {
    if (err.name === 'SyntaxError') {
        logger.severe('Configuration file is not valid JSON. Please verify it\'s contents.');
    } else if (err.code === 'ENOENT') {
        logger.severe('Configuration not found. Make sure you copy config.json.example to config.json and fill it out.');
    } else {
        logger.severe('Unknown error loading configuration file:');
        logger.severe(err);
    }
    process.exit(1);
}

const config = bot.config;

// Mafia Bot Specific Caches - filled in on ready
bot.mafia = {};
bot.mafia.mods = [];
bot.mafia.channels = [];
bot.mafia.votes = [];

bot.mafia.buildVoteTable = () => {
    let vote_table = new Map();

    bot.mafia.votes.forEach(vote => {
        if (!vote_table.has(vote.target)) {
            vote_table.set(vote.target, []);
        }

        vote_table.get(vote.target).push(vote.voter);
    });

    return vote_table;
};

bot.mafia.buildVoteOutput = () => {
    let vote_table = bot.mafia.buildVoteTable();
    let output = [];
    output.push(':ballot_box: **Current Vote Count:** :ballot_box:\n');

    if (vote_table.size === 0) {
        output.push('There are currently no votes.');
    }

    for (let [key, value] of vote_table) {
        let target = bot.users.get(key).username || 'No Lynch';

        output.push(`__**${target}**__ \`(${value.length})\``);

        value.forEach(voter => {
            output.push(bot.users.get(voter).username);
        });

        output.push('');
    }

    return output.join('\n');
};

if (!config.botToken || !/^[A-Za-z0-9\._\-]+$/.test(config.botToken)) {
    logger.severe('Config is missing a valid bot token! Please acquire one at https://discordapp.com/developers/applications/me');
    process.exit(1);
}

let invite_template = 'https://discordapp.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=3072';

bot.on('ready', () => {
    bot.utils = require('./utils');

    commands.loadCommands(path.join(__dirname, 'commands'));

    (title => {
        process.title = title;
        process.stdout.write(`\u001B]0;${title}\u0007`);
    })(`SharpCore - ${bot.user.username}`);

    logger.info(stripIndents`Stats:
        - User: ${bot.user.username}#${bot.user.discriminator} <ID: ${bot.user.id}>
        - Users: ${bot.users.filter(user => !user.bot).size}
        - Bots: ${bot.users.filter(user => user.bot).size}
        - Channels: ${bot.channels.size}
        - Guilds: ${bot.guilds.size}`
    );

    stats.set('start-time', process.hrtime());

    delete bot.user.email;
    delete bot.user.verified;

    bot.user.setGame(`${config.prefix}help`);

    // Load Mafia caches
    bot.db.get('mafia.mods').then(mods => {
        bot.mafia.mods = mods || [];
    });

    bot.db.get('mafia.channels').then(channel_list => {
        bot.mafia.channels = channel_list || [];
    });

    bot.db.get('mafia.votes').then(votes => {
        bot.mafia.votes = votes || [];
    });

    logger.info('Bot loaded');
    logger.info(`Use the following link to invite ${bot.user.username} to your server:\n` + chalk.blue(invite_template.replace('YOUR_CLIENT_ID', bot.user.id)));

});

bot.on('message', msg => {
    stats.increment(`messages-${bot.user.id === msg.author.id ? 'sent' : 'received'}`);
    if (msg.isMentioned(bot.user)) {
        stats.increment('mentions');
    }

    if (!msg.content.startsWith(config.prefix)) return;
    if (msg.author.bot) return;

    var split = msg.content.split(' ');
    var base = split[0].substr(config.prefix.length).toLowerCase();
    var args = split.slice(1);

    var command = commands.get(base);

    if (command) {
        commands.execute(msg, command, args);
    }
});

bot.on('error', console.error);
bot.on('warn', console.warn);
bot.on('disconnect', console.warn);

bot.login(config.botToken);

bot.on('messageUpdate', (oldMsg, newMsg) => {
    let mods = bot.mafia.mods;
    let channels = bot.mafia.channels;
    if (oldMsg.author.bot) return; // #nope.
    if (oldMsg.content === newMsg.content) return; // lol embeds do this. srsly.

    if (channels.indexOf(oldMsg.channel.id) > -1 && mods.indexOf(oldMsg.author.id) < 0) {
        mods.forEach(modid => {
            let mod = bot.users.get(modid);
            mod.send(`This message from <@${oldMsg.author.id}> was edited in <#${oldMsg.channel.id}> on ${oldMsg.guild.name}: \n**Old**:`);
            mod.send(`\`\`\`${oldMsg.content}\`\`\``);
            mod.send('**New:**');
            mod.send(`\`\`\`${newMsg.content}\`\`\``);
        });
    }
});

bot.on('messageDelete', (msg) => {
    let mods = bot.mafia.mods;
    let channels = bot.mafia.channels;
    if (msg.author.bot) return;

    if (channels.indexOf(msg.channel.id) > -1 && mods.indexOf(msg.author.id) < 0) {
        mods.forEach(modid => {
            let mod = bot.users.get(modid);
            mod.send(`This message from <@${msg.author.id}> was deleted in <#${msg.channel.id}> on ${msg.guild.name}:`);
            mod.send(`\`\`\`${msg.content}\`\`\``);
        });
    }
});

process.on('uncaughtException', (err) => {
    let errorMsg = (err.stack || err || '').toString().replace(new RegExp(`${__dirname}\/`, 'g'), './');
    logger.severe(errorMsg);
});

process.on('unhandledRejection', err => {
    logger.severe('Uncaught Promise error: \n' + err.stack);
});
