
import { observable, action } from 'mobx';
import axios from 'axios';
import { ipcRenderer } from 'electron';

import storage from 'utils/storage';
import helper from 'utils/helper';
import contacts from './contacts';
import session from './session';
import members from './members';
import settings from './settings';

async function resolveMessage(message) {
    var auth = await storage.get('auth');
    var isChatRoom = helper.isChatRoom(message.FromUserName);
    var content = isChatRoom ? message.Content.split(':<br/>')[1] : message.Content;

    switch (message.MsgType) {
        case 1:
            // Text message and Location
            if (message.Url && message.OriContent) {
                // This message is a location
                let parts = message.Content.split(':<br/>');
                let location = helper.parseKV(message.OriContent);

                location.image = `${axios.defaults.baseURL}${parts[isChatRoom ? 2 : 1]}`.replace(/\/+/g, '/');
                location.href = message.Url;

                message.location = location;
            };
            break;
        case 3:
            // Image
            let image = helper.parseKV(content);
            image.src = `${axios.defaults.baseURL}cgi-bin/mmwebwx-bin/webwxgetmsgimg?&msgid=${message.MsgId}&skey=${auth.skey}`;
            message.image = image;
            break;

        case 34:
            // Voice
            let voice = helper.parseKV(content);
            voice.src = `${axios.defaults.baseURL}cgi-bin/mmwebwx-bin/webwxgetvoice?&msgid=${message.MsgId}&skey=${auth.skey}`;
            message.voice = voice;
            break;

        case 47:
            // External emoji
            if (!content) break;

            let emoji = helper.parseKV(content);

            emoji.src = `${axios.defaults.baseURL}cgi-bin/mmwebwx-bin/webwxgetmsgimg?&msgid=${message.MsgId}&skey=${auth.skey}`;
            message.emoji = emoji;
            break;

        case 42:
            // Contact
            let contact = message.RecommendInfo;

            contact.image = `${axios.defaults.baseURL}cgi-bin/mmwebwx-bin/webwxgeticon?seq=0&username=${contact.UserName}&skey=${auth.skey}&msgid=${message.MsgId}`;
            contact.name = contact.NickName;
            contact.address = `${contact.Province || 'UNKNOW'}, ${contact.City || 'UNKNOW'}`;
            contact.isFriend = !!contacts.memberList.find(e => e.UserName === contact.UserName);
            message.contact = contact;
            break;

        case 43:
            // Video
            let video = {
                cover: `${axios.defaults.baseURL}cgi-bin/mmwebwx-bin/webwxgetmsgimg?&MsgId=${message.MsgId}&skey=${auth.skey}&type=slave`,
                src: `${axios.defaults.baseURL}cgi-bin/mmwebwx-bin/webwxgetvideo?msgid=${message.MsgId}&skey=${auth.skey}`,
            };

            message.video = video;
            break;

        case 49:
            switch (message.AppMsgType) {
                case 2000:
                    // Transfer
                    let { value } = helper.parseXml(message.Content, 'des');

                    message.MsgType += 2000;
                    message.transfer = {
                        desc: value,
                        money: +value.match(/[\d.]+元/)[0].slice(0, -1),
                    };
                    break;

                case 17:
                    // Location sharing...
                    message.MsgType += 17;
                    break;

                case 6:
                    // Receive file
                    let file = {
                        name: message.FileName,
                        size: message.FileSize,
                        mediaId: message.MediaId,
                        extension: (message.FileName.match(/\.\w+$/) || [])[0],
                    };

                    file.uid = await helper.getCookie('wxuin');
                    file.ticket = await helper.getCookie('webwx_data_ticket');
                    file.download = `${axios.defaults.baseURL.replace(/^https:\/\//, 'https://file.')}cgi-bin/mmwebwx-bin/webwxgetmedia?sender=${message.FromUserName}&mediaid=${file.mediaId}&filename=${file.name}&fromuser=${file.uid}&pass_ticket=undefined&webwx_data_ticket=${file.ticket}`;

                    message.MsgType += 6;
                    message.file = file;
                    break;

                default:
                    console.error('Unknow app message: %o', Object.assign({}, message));
                    message.Content = `收到一条暂不支持的消息类型，请在手机上查看（${message.FileName || 'No Title'}）。`;
                    message.MsgType = 19999;
                    break;
            }
            break;

        case 10000:
            let userid = message.FromUserName;

            // Chat room has been changed
            await contacts.batch([userid]);

            // Refresh the current chat room info
            if (helper.isChatRoom(userid)) {
                let user = await contacts.getUser(userid);

                if (userid === self.user.UserName) {
                    self.chatTo(user);
                }

                if (members.show
                    && members.user.UserName === userid) {
                    members.toggle(true, user);
                }
            }
            break;

        default:
            // Unhandle message
            message.Content = 'Unknow message type: ' + message.MsgType;
            message.MsgType = 19999;
    }

    return message;
}

class Chat {
    @observable sessions = [];
    @observable messages = new Map();
    @observable user = false;

    @action async loadChats(chatSet) {
        var list = contacts.memberList;
        var res = [];
        var temps = [];
        var sorted = [];

        if (!chatSet) return;

        helper.unique(chatSet.split(',')).map(e => {
            var user = list.find(user => user.UserName === e && !helper.isChatRoom(e));

            if (user) {
                res.push(user);
            } else {
                // User not in your contact
                temps.push(e);
            }
        });

        if (temps.length) {
            await contacts.batch(temps);

            temps.map(e => {
                var user = list.find(user => user.UserName === e);

                // Remove all the invalid accounts, eg: Official account
                if (user) {
                    res.push(user);
                }
            });
        }

        res.map((e, index) => {
            self.messages.set(e.UserName, {
                data: [],
                unread: 0,
            });

            // Save the original index to support sticky feature
            e.index = index;

            if (helper.isTop(e)) {
                sorted.unshift(e);
            } else {
                sorted.push(e);
            }
        });

        self.sessions.replace(sorted);

        return res;
    }

    @action chatTo(user) {
        var sessions = self.sessions;
        var stickyed = [];
        var normaled = [];
        var index = self.sessions.findIndex(e => e.UserName === user.UserName);

        if (index === -1) {
            // User not in chatset
            sessions = [user, ...self.sessions];

            self.messages.set(user.UserName, {
                data: [],
                unread: 0,
            });
        }

        sessions.map(e => {
            if (helper.isTop(e)) {
                stickyed.push(e);
            } else {
                normaled.push(e);
            }
        });

        self.sessions.replace([...stickyed, ...normaled]);
        self.user = user;
        self.markedRead(user.UserName);
    }

    @action async addMessage(message) {
        /* eslint-disable */
        var from = message.FromUserName;
        var user = await contacts.getUser(from);
        var list = self.messages.get(from);
        var sessions = self.sessions;
        var stickyed = [];
        var normaled = [];
        /* eslint-enable */

        // Check new message is already in the chat set
        if (list) {
            // Swap the chatset order
            let index = self.sessions.findIndex(e => e.UserName === from);

            if (index !== -1) {
                sessions = [
                    ...self.sessions.slice(index, index + 1),
                    ...self.sessions.slice(0, index),
                    ...self.sessions.slice(index + 1, self.sessions.length)
                ];
            } else {
                // User not in chatset
                sessions = [user, ...self.sessions];
            }

            // Drop the duplicate message
            if (!list.data.find(e => e.NewMsgId === message.NewMsgId)) {
                message = await resolveMessage(message);

                if (settings.showNotification && !helper.isMuted(user)) {
                    // Get the user avatar and use it as notifier icon
                    let response = await axios.get(user.HeadImgUrl, { responseType: 'arraybuffer' });
                    let base64 = new window.Buffer(response.data, 'binary').toString('base64');

                    ipcRenderer.send('receive-message', {
                        icon: base64,
                        title: user.RemarkName || user.NickName,
                        message: helper.getMessageContent(message),
                    });
                }
                list.data.push(message);
            }
        } else {
            // New friend has accepted
            sessions = [user, ...self.sessions];
            list = {
                data: [message],
                unread: 0,
            };
        }

        if (self.user.UserName === from) {
            // Message has readed
            list.unread = list.data.length;
        }

        sessions = sessions.map(e => {
            // Catch the contact update, eg: MsgType = 10000, chat room name has changed
            var user = contacts.memberList.find(user => user.UserName === e.UserName);

            // Fix sticky bug
            if (helper.isTop(user)) {
                stickyed.push(user);
            } else {
                normaled.push(user);
            }
        });

        self.sessions.replace([...stickyed, ...normaled]);
        self.messages.set(from, list);
    }

    @action async sendTextMessage(auth, message, isForward) {
        var response = await axios.post(`/cgi-bin/mmwebwx-bin/webwxsendmsg`, {
            BaseRequest: {
                Sid: auth.wxsid,
                Uin: auth.wxuin,
                Skey: auth.skey,
            },
            Msg: {
                Content: message.content,
                FromUserName: message.from,
                ToUserName: message.to,
                ClientMsgId: message.ClientMsgId,
                LocalID: message.LocalID,
                Type: 1,
            },
            Scene: isForward ? 2 : 0,
        });
        var res = {
            data: response.data,

            item: {
                isme: true,
                Content: message.content,
                MsgType: 1,
                CreateTime: +new Date() / 1000,
                HeadImgUrl: session.user.User.HeadImgUrl,
            },
        };

        if (res.data.BaseResponse.Ret !== 0) {
            console.error('Failed to send message: %o', response.data);
        }

        return res;
    }

    @action async sendEmojiMessage(auth, message) {
        var response = await axios.post(`/cgi-bin/mmwebwx-bin/webwxsendemoticon?fun=sys&lang=en_US&pass_ticket=${auth.passTicket}`, {
            BaseRequest: {
                Sid: auth.wxsid,
                Uin: auth.wxuin,
                Skey: auth.skey,
            },
            Msg: {
                FromUserName: message.from,
                ToUserName: message.to,
                ClientMsgId: message.ClientMsgId,
                LocalID: message.LocalID,
                Type: 47,
                EMoticonMd5: message.emoji.md5,
            },
            Scene: 2,
        });
        var res = {
            data: response.data,

            item: Object.assign({}, message, {
                isme: true,
                CreateTime: +new Date() / 1000,
                HeadImgUrl: session.user.User.HeadImgUrl,
            }),
        };

        if (res.data.BaseResponse.Ret !== 0) {
            console.error('Failed to send emoji: %o', response.data);
        }

        return res;
    }

    @action async sendImageMessage(auth, message, isForward) {
        var response = await axios.post('/cgi-bin/mmwebwx-bin/webwxsendmsgimg?fun=async&f=json', {
            BaseRequest: {
                Sid: auth.wxsid,
                Uin: auth.wxuin,
                Skey: auth.skey,
            },
            Msg: {
                Content: message.content,
                FromUserName: message.from,
                ToUserName: message.to,
                ClientMsgId: message.ClientMsgId,
                LocalID: message.LocalID,
                MediaId: isForward ? '' : message.file.mediaId,
                Type: 3,
            },
            Scene: isForward ? 2 : 0,
        });
        var res = {
            data: response.data,

            item: Object.assign({}, message, {
                isme: true,
                CreateTime: +new Date() / 1000,
                MsgId: response.data.MsgID,
                HeadImgUrl: session.user.User.HeadImgUrl,

                MsgType: 3,
                image: {
                    src: `${axios.defaults.baseURL}cgi-bin/mmwebwx-bin/webwxgetmsgimg?&msgid=${response.data.MsgID}&skey=${auth.skey}`
                }
            }),
        };

        if (res.data.BaseResponse.Ret !== 0) {
            console.error('Failed to send image: %o', response.data);
        }

        return res;
    }

    @action async sendFileMessage(auth, message, isForward) {
        var response = await axios.post('/cgi-bin/mmwebwx-bin/webwxsendappmsg?fun=async&f=json', {
            BaseRequest: {
                Sid: auth.wxsid,
                Uin: auth.wxuin,
                Skey: auth.skey,
            },
            Msg: {
                Content: `
                    <appmsg appid="wxeb7ec651dd0aefa9" sdkver="">
                       <title>${message.file.name}</title>
                       <des />
                       <action />
                       <type>6</type>
                       <content />
                       <url />
                       <lowurl />
                       <appattach>
                          <totallen>${message.file.size}</totallen>
                          <attachid>${message.file.mediaId}</attachid>
                          <fileext>${message.file.extension}</fileext>
                       </appattach>
                       <extinfo />
                    </appmsg>
                `,
                FromUserName: message.from,
                ToUserName: message.to,
                ClientMsgId: message.ClientMsgId,
                LocalID: message.LocalID,
                MediaId: '',
                Type: 6,
            },
            Scene: isForward ? 2 : 0,
        });
        var res = {
            data: response.data,

            item: Object.assign({}, message, {
                isme: true,
                CreateTime: +new Date() / 1000,
                MsgId: response.data.MsgID,
                MsgType: 49 + 6,
                HeadImgUrl: session.user.User.HeadImgUrl,
            }),
        };

        if (res.data.BaseResponse.Ret !== 0) {
            console.error('Failed to send file: %o', response.data);
        }

        return res;
    }

    @action async sendMessage(user, message, isForward = false) {
        var id = (+new Date() * 1000) + Math.random().toString().substr(2, 4);
        var auth = await storage.get('auth');
        var from = session.user.User.UserName;
        var to = user.UserName;
        var res;

        if (message.type === 1) {
            res = await self.sendTextMessage(auth, {
                content: message.content,
                from,
                to,
                ClientMsgId: id,
                LocalID: id,
            }, isForward);
        } else if (message.type === 47) {
            res = await self.sendEmojiMessage(auth, Object.assign({}, message, {
                content: message.content,
                from,
                to,
                ClientMsgId: message.MsgId,
                LocalID: id,
            }), isForward);
        } else if (message.type === 3) {
            let data = Object.assign({}, message, {
                content: '',
                from,
                to,
                ClientMsgId: message.MsgId,
                LocalID: id,
            });

            if (isForward === true) {
                Object.assign(data, {
                    content: helper.decodeHTML(message.content),
                });
            }
            res = await self.sendImageMessage(auth, data, isForward);
        } else if (message.type === 49 + 6) {
            res = await self.sendFileMessage(auth, Object.assign({}, message, {
                from,
                to,
                ClientMsgId: id,
                LocalID: id,
            }), isForward);
        } else {
            return false;
        }

        var { data, item } = res;

        self.chatTo(user);

        if (data.BaseResponse.Ret === 0) {
            // Sent success
            let list = self.messages.get(to);

            list.data.push(item);

            if (!helper.isChatRoom(user.UserName)
                && !user.isFriend) {
                // The target is not your friend
                list.data.push({
                    Content: `${user.sex ? 'She' : 'He'} is not your friend, <a class="addFriend" data-userid="${user.UserName}">Send friend request</a>`,
                    MsgType: 19999,
                });
            }

            self.markedRead(to);
            self.messages.set(to, list);

            return true;
        }

        return false;
    }

    @action async upload(file) {
        var id = (+new Date() * 1000) + Math.random().toString().substr(2, 4);
        var auth = await storage.get('auth');
        var ticket = await helper.getCookie('webwx_data_ticket');
        var formdata = new window.FormData();
        var server = axios.defaults.baseURL.replace(/https:\/\//, 'https://file.') + 'cgi-bin/mmwebwx-bin/webwxuploadmedia?f=json';
        var mediaType = helper.getMediaType(file.name.split('.').slice(-1).pop());

        // Increase the counter
        self.upload.count = self.upload.count ? 0 : self.upload.count + 1;

        formdata.append('id', `WU_FILE_${self.upload.counter}`);
        formdata.append('name', file.name);
        formdata.append('type', file.type);
        formdata.append('lastModifieDate', new Date(file.lastModifieDate).toString());
        formdata.append('size', file.size);
        formdata.append('mediatype', mediaType);
        formdata.append('uploadmediarequest', JSON.stringify({
            BaseRequest: {
                Sid: auth.wxsid,
                Uin: auth.wxuin,
                Skey: auth.skey,
            },
            ClientMediaId: id,
            DataLen: file.size,
            FromUserName: session.user.User.UserName,
            MediaType: 4,
            StartPos: 0,
            ToUserName: self.user.UserName,
            TotalLen: file.size,
        }));
        formdata.append('webwx_data_ticket', ticket);
        formdata.append('pass_ticket', auth.passTicket);
        formdata.append('filename', file.slice(0, file.size));

        var response = await axios.post(server, formdata);

        if (response.data.BaseResponse.Ret === 0) {
            return {
                mediaId: response.data.MediaId,
                type: {
                    'pic': 3,
                    'video': 43,
                    'doc': 49 + 6,
                }[mediaType],
            };
        }

        return false;
    }

    @action deleteMessage(userid, messageid) {
        var list = self.messages.get(userid);

        list.data = list.data.filter(e => e.MsgId !== messageid);
        list.unread = 0;
        self.messages.set(userid, list);
    }

    @action markedRead(userid) {
        var list = self.messages.get(userid);

        if (list) {
            list.unread = list.data.length;
        } else {
            list = {
                data: [],
                unread: 0,
            };
        }

        self.messages.set(userid, list);
    }

    @action async sticky(user) {
        var auth = await storage.get('auth');
        var sticky = +!helper.isTop(user);
        var response = await axios.post('/cgi-bin/mmwebwx-bin/webwxoplog', {
            BaseRequest: {
                Sid: auth.wxsid,
                Uin: auth.wxuin,
                Skey: auth.skey,
            },
            CmdId: 3,
            OP: sticky,
            RemarkName: '',
            UserName: user.UserName
        });
        var sorted = [];

        if (+response.data.BaseResponse.Ret === 0) {
            self.sessions.find(e => e.UserName === user.UserName).isTop = !!sticky;
            self.sessions.sort((a, b) => a.index - b.index).map(e => {
                if (helper.isTop(e)) {
                    sorted.unshift(e);
                } else {
                    sorted.push(e);
                }
            });
            self.sessions.replace(sorted);

            return true;
        }

        return false;
    }

    @action removeChat(user) {
        var sessions = self.sessions.filter(e => e.UserName !== user.UserName);
        self.sessions.replace(sessions);
    }

    @action empty(user) {
        // Empty the chat content
        self.messages.set(user.UserName, {
            data: [],
            unread: 0,
        });
    }
}

const self = new Chat();
export default self;