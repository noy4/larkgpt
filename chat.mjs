import aircode from 'aircode';
import OpenAI from 'openai';
import * as lark from '@larksuiteoapi/node-sdk';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = 'gpt-3.5-turbo';
const OPENAI_MAX_TOKENS = 256;
const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const EventDB = aircode.db.table('event');
const MessageDB = aircode.db.table('message');

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const larkClient = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
});

/**
 * Create completion and reply to lark
 */
export default async function (params, context) {
  if (params.encrypt) return { error: "don't encrypt please." };
  // for setup verification
  if (params.challenge) return { challenge: params.challenge };

  const eventId = params.header?.event_id;
  if (!eventId) return { error: 'no event_id' };

  // To check if a request is repeated, we save the eventId.
  // Lark may retry the request since the OpenAI API takes
  // time to reply.
  const event = await EventDB.where({ eventId }).findOne();
  if (event) return { error: 'repeated event' };
  await EventDB.save({ eventId });

  const message = params.event.message;
  const messageId = message.message_id;
  const rootId = message.root_id;
  let sessionId = rootId || messageId;
  const text = JSON.parse(message.content).text;

  // Basically, the root_id points to the first message you've
  // sent. But when you reply in a thread, the target message
  // you're replying to becomes a new root, so you should use
  // the root's root_id as the sessionId.
  if (rootId) {
    const rootMessage = await MessageDB.where({
      'lark.message_id': rootId,
    }).findOne();
    const superRootId = rootMessage?.lark.root_id;
    if (superRootId) {
      sessionId = superRootId;
    }
  }

  // Check if the message is relevant to the bot's conversation
  const mention = text.includes('@_user_1');
  if (mention) react(messageId, 'MeMeMe');
  const messages = await MessageDB.where({ sessionId })
    .sort({ createdAt: 1 })
    .find();
  if (!mention && !messages.length) return { error: 'not called' };

  try {
    // create completion and reply to lark
    const content = text.replace('@_user_1', '').trim();
    const userMessage = { role: 'user', content };
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [...messages.map((m) => m.openai), userMessage],
      max_tokens: OPENAI_MAX_TOKENS,
    });
    const aiMessage = completion.choices[0].message;
    const answer = await reply(messageId, aiMessage.content);
    await MessageDB.save([
      { sessionId, openai: userMessage, lark: message },
      { sessionId, openai: aiMessage, lark: answer.data },
    ]);
  } catch (e) {
    await reply(messageId, e.message);
  }
}

/**
 * Reply to lark
 */
async function reply(messageId, content) {
  return await larkClient.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ text: content }),
      msg_type: 'text',
    },
  });
}

/**
 * Add a reaction for a message
 */
async function react(messageId, type) {
  return await larkClient.im.messageReaction.create({
    path: { message_id: messageId },
    data: { reaction_type: { emoji_type: type } },
  });
}
