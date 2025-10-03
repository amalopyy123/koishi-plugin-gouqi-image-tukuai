import { Context, Schema, h, arrayBufferToBase64, SessionError, segment } from 'koishi'



export const name = 'gouqi-image-tukuai'

export interface Config { }

export const Config: Schema<Config> = Schema.object({
  rpxy_url_txt2img: Schema.string().default('').description('文生图地址'),
  rpxy_url_img2img: Schema.string().default('').description('图生图地址'),
  token: Schema.string().default('').role("secret").description('token'),
  sampler_index: Schema.string().default('Euler a').description("sampler_index,Euler a,DPM++ 2M"),
  additional_prompt: Schema.string().default('masterpiece, best quality, ultra-detailed, extremely detailed, best quality').description('附加提示词'),
  negative_prompt: Schema.string().default('owres, bad anatomy, bad hands, text, error, (missing fingers), extra digit, fewer digits, cropped, worst quality, low quality, signature, watermark, username, long neck, Humpbacked, bad crotch, bad crotch seam, fused crotch, fused seam, poorly drawn crotch, poorly drawn crotch seam, bad thigh gap, missing thigh gap, fused thigh gap, bad anatomy, short arm, (((missing arms))), missing thighs, missing calf, mutation, duplicate, more than 1 left hand, more than 1 right hand, deformed, (blurry), missing legs, extra arms, extra thighs, more than 2 thighs, extra calf, fused calf, extra legs, bad knee, extra knee, more than 2 legs').description('负面提示词'),
  steps: Schema.number().default(28).description('步数，28是免费，报错的话要调到28以上'),
  denoising_strength: Schema.number().default(0.1).description('1 - 相似度'),
  cfg_scale: Schema.number().default(8).description('低 cfg_scale 值：更有创意；高 cfg_scale 值：更加服从。对于绝大多数用户和绝大多数情况，7 是最理想的起始值。'),
  seed: Schema.number().default(-1).description('种子'),
  allow_image: Schema.boolean().default(true).description('是否允许图生图'),
  collapse_response: Schema.boolean().default(true).description('折叠回复'),
  translate_input: Schema.boolean().default(false).description('翻译输入')
})
export const inject = {
  required: ['http', 'gouqi_translator_yd1', 'gouqi_base']
};

function hasSensitiveWords(input) {
  const lowercaseInput = input.toLowerCase();
  const nsfwKeywords = [
    "nsfw",
    "nude",
    "porn",
    "hentai",
    "ecchi",
    "gore",
    "violence",
    "rape",
    "incest",
    "pedophile",
    "pussy",
    "cock",
    "dick",
    "vagina",
    "penis",
    "ass",
    "boobs",
    "tits",
    "cum",
    "anal",
    "masturbation",
    //  ... 这里可以添加更多你认为相关的关键词 ...
  ];
  for (const keyword of nsfwKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return true;
    }
  }
  return false;
}
//jimp不支持"image/webp"
var ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
//10M
var MAX_CONTENT_SIZE = 10485760;
async function downloadImage(ctx, url, headers = {}) {
  const image = await ctx.http(url, { responseType: "arraybuffer", headers });
  if (+image.headers.get("content-length") > MAX_CONTENT_SIZE) {
    throw new Error(".file-too-large");
  }
  const mimetype = image.headers.get("content-type");
  if (!ALLOWED_TYPES.includes(mimetype)) {
    throw new Error(".unsupported-file-type");
  }
  const buffer = image.data;
  const base64 = arrayBufferToBase64(buffer);
  return { buffer, base64, dataUrl: `data:${mimetype};base64,${base64}` };
}

function hasChinese(str) {
  const regex = /[\u4e00-\u9fa5]/;
  return regex.test(str);
}

export function apply(ctx: Context, config) {
  let paramsTextToImg, paramsImgToImg;
  function initParams() {
    paramsTextToImg = {
      "enable_hr": true,
      "denoising_strength": 0.8,
      "hr_scale": 2,
      "hr_upscaler": "Latent",
      "hr_second_pass_steps": 10,
      "prompt": "masterpiece, nsfw, breast,cowgirl, best quality, long hair, looking at viewer, blue eyes, school uniform, classroom",
      "seed": config.seed,
      "sampler_name": config.sampler_index,
      "steps": config.steps,
      "cfg_scale": config.cfg_scale,
      "width": 512,
      "height": 768,
      //"negative_prompt": "(easynegative:1.1), (verybadimagenegative_v1.3:1), (low quality:1.2), (worst quality:1.2)"
      "negative_prompt": config.negative_prompt
    }
    paramsImgToImg = {
      "init_images": ["data:image/jpeg;base64,..."],
      "denoising_strength": 0.1,
      "prompt": "masterpiece, best quality, catgirl, cute",
      "styles": [
        "Resize and fill"
      ],
      "seed": config.seed,
      "steps": config.steps,
      "cfg_scale": config.cfg_scale,
      "width": 512,
      "height": 512,
      "sampler_index": config.sampler_index,
      "negative_prompt": config.negative_prompt
    }
  }

  /**
 * 根据特定规则计算新的图片尺寸
 * 规则1: 如果宽或高小于MIN_DIMENSION，则按比例放大，确保最小边等于MIN_DIMENSION
 * 规则2: 如果宽或高大于MAX_DIMENSION，则按比例缩小，确保最大边等于MAX_DIMENSION
 * 规则3: 否则，尺寸保持不变
 *
 * @param {number} originalWidth 原始宽度
 * @param {number} originalHeight 原始高度
 * @returns {{width: number, height: number}} 包含新宽度和新高度的对象
 */
  function calculateNewDimensions(originalWidth, originalHeight) {
    const MIN_DIMENSION = 700;
    const MAX_DIMENSION = 1500;

    let newWidth = originalWidth;
    let newHeight = originalHeight;

    // 规则1: 需要放大
    if (originalWidth < MIN_DIMENSION || originalHeight < MIN_DIMENSION) {
      let ratio;
      // 基于更小的那条边来计算缩放比例
      if (originalWidth < originalHeight) {
        ratio = MIN_DIMENSION / originalWidth;
      } else {
        ratio = MIN_DIMENSION / originalHeight;
      }
      newWidth = Math.round(originalWidth * ratio);
      newHeight = Math.round(originalHeight * ratio);
    }
    // 规则2: 需要缩小 (使用 else if 是因为放大和缩小是互斥的)
    else if (originalWidth > MAX_DIMENSION || originalHeight > MAX_DIMENSION) {
      let ratio;
      // 基于更大的那条边来计算缩放比例
      if (originalWidth > originalHeight) {
        ratio = MAX_DIMENSION / originalWidth;
      } else {
        ratio = MAX_DIMENSION / originalHeight;
      }
      newWidth = Math.round(originalWidth * ratio);
      newHeight = Math.round(originalHeight * ratio);
    }

    // 规则3: 尺寸在范围内，不需要改变，直接返回计算结果（初始值）
    return { width: newWidth, height: newHeight };
  }

  async function generateImage({ session, options: options2 }, input) {
    //const { hasAt, content, atSelf } = session.stripped;
    let imgList = h.select(input, 'img').map((item) => h.image(item.attrs.src));
    let atList = h.select(input, 'at').map((item) => h.text(item.attrs.id));
    let sentImage = imgList.length > 0 || atList.length > 0;

    if (!config.allow_image && sentImage) {
      throw new SessionError("不允许输入图片");
    }

    let textList = h.select(input, 'text').map((item) => h.text(item.attrs.content));
    let textPromt = '';
    textList.map(item => { textPromt += item.attrs.content });

    if (hasSensitiveWords(textPromt)) {
      //提时含有敏感词
      const bot = session.bot;
      try {
        const data2 = await bot.internal.getStrangerInfo(session.userId);
        session.send("不可以涩涩！打屎" + data2.nickname + "!!!");
      } catch (error) {
        session.send("不可以涩涩！");
      }
      return;
    }

    if (config.translate_input) {
      try {
        if (hasChinese(textPromt)) {
          textPromt = await ctx['gouqi_translator_yd1'].translate(ctx, textPromt);
        }
        initParams();
        const headers = {
          'Content-Type': 'application/json'
        };
        let base64Url = '';
        let promtToSend = textPromt + ',' + config.additional_prompt;
        let response;
        //sentImage = true;
        if (sentImage) {
          //图生图
          paramsImgToImg.prompt = promtToSend;

          let imgUrl;
          if (imgList.length != 0) {
            imgUrl = imgList[0].attrs.src;
          } else {
            let atId = atList[0];
            imgUrl = `http://q.qlogo.cn/headimg_dl?dst_uin=${atId}&spec=640`;
          }
          //imgUrl = 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/96/8c/d0/968cd034-038e-2648-5718-77a5eeb82921/AppIcon-0-1x_U007emarketing-0-7-0-85-220-0.png/230x0w.webp';
          //imgUrl = 'https://img.duoziwang.com/2021/04/08051804301493.jpg';
          //const imgUrl = imgList[0].attrs.src;
          const image = await downloadImage(ctx, imgUrl);
          if (image.base64.length < 100) {
            throw new Error('无法获取参考图片');
          }
          let origDimensions = ctx['gouqi_base'].getImage64Dimensions(image.dataUrl);
          const newDimensions = calculateNewDimensions(origDimensions.width, origDimensions.height);
          if (
            (newDimensions.width < 700 || newDimensions.width > 1500) ||
            (newDimensions.height < 700 || newDimensions.height > 1500)
          ) {
            throw new Error('无法适配图片尺寸');
          }
          //console.log(origDimensions);
          //console.log(newDimensions);
          //经测试，参考图的大小对结果的影响非常大，如果参考图太小生成的图片质量会非常差
          const resizedImage64 = await ctx['gouqi_base'].resizeImage64(image.dataUrl, newDimensions.width, newDimensions.height);
          //console.log(image.dataUrl)
          paramsImgToImg.init_images = [resizedImage64];
          response = await ctx.http(config.rpxy_url_img2img, {
            method: "POST",
            headers: headers,
            timeout: 9900000,
            data: paramsImgToImg,
            responseType: 'arraybuffer'
          });
          // 从 response.data 中获取服务器返回的数据
          const resData = response.data;
          // 检查返回的数据是否有效 (例如，是否为 ArrayBuffer 或有长度)
          if (resData && resData.byteLength > 0) {
            // 将 ArrayBuffer 转换为 Node.js 的 Buffer 对象
            const respnseBuffer = Buffer.from(resData);
            // 将 Buffer 转换为 utf8 字符串
            const jsonString = respnseBuffer.toString('utf8');
            //log前100个字符看结构，图生图的images不是数组
            //console.log(jsonString.slice(0, 100));
            //{
            // "images": "iVBORw0KGgoAAAANSUhEUgAAAoAAAAKACAIAAACDr150AAAFzHRFWHRwcm9tcHQAeyIzIjogeyJpbnB1dHM
            const parsedObject = JSON.parse(jsonString);
            if (parsedObject && parsedObject.images) {
              const b64 = parsedObject.images;
              let mimeType = "image/jpeg";
              base64Url = `data:${mimeType};base64,${b64}`;
            } else {
              throw new Error('无法提取base64的图片');
            }
          }
        } else {
          //文生图
          paramsTextToImg.prompt = promtToSend;
          response = await ctx.http(config.rpxy_url_txt2img, {
            method: "POST",
            headers: headers,
            timeout: 9900000,
            data: paramsTextToImg,
            responseType: 'arraybuffer'
          });
          // 从 response.data 中获取服务器返回的数据
          const resData = response.data;
          // 检查返回的数据是否有效 (例如，是否为 ArrayBuffer 或有长度)
          if (resData && resData.byteLength > 0) {
            // 将 ArrayBuffer 转换为 Node.js 的 Buffer 对象
            const respnseBuffer = Buffer.from(resData);
            // 将 Buffer 转换为 utf8 字符串
            const jsonString = respnseBuffer.toString('utf8');
            //log前100个字符看结构，文生图的images是数组
            //console.log(jsonString.slice(0, 100));
            //{
            // "images": [
            //   "iVBORw0KGgoAAAANSUhEUgAAA4AAAAUQCAIAAACa4Kl5AAAMgHRFWHRwcm9tcHQAeyIxIjoge
            const parsedObject = JSON.parse(jsonString);
            if (parsedObject && parsedObject.images && Array.isArray(parsedObject.images) && parsedObject.images.length > 0) {
              const b64 = parsedObject.images[0];
              let mimeType = "image/jpeg";
              base64Url = `data:${mimeType};base64,${b64}`;
            } else {
              throw new Error('无法提取base64的图片');
            }
          }
        }
        if (base64Url.length < 123) {
          throw new Error('生成图片失败');
        }
        if (!config.collapse_response) {
          return segment.image(base64Url);
        }
        const result = h('figure');
        const attrs = {
          userId: session.userId,
          nickname: session.author?.nickname || session.username,
        }
        result.children.push(h('message', attrs, 'prompts: ' + promtToSend));
        //result.children.push(h('message', attrs, 'negative_prompt: ' + paramsToSend.negative_prompt));
        result.children.push(h('message', attrs, segment.image(base64Url)));
        await session.send(result);
      } catch (err) {
        ctx.logger.warn(err);
      }
    }

  }
  ctx
    .command("image-novel <prompts:text>")
    .alias("画图novel")
    .alias("画图n")
    .action(async ({ session, options: options2 }, input) => {
      return generateImage({ session, options: options2 }, input)
    }
    );
}

