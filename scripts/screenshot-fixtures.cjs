'use strict'

/**
 * README 截图用的演示数据（纯虚构）。
 *
 * 三条硬约束：
 *   1. **不碰真实数据库**。截图脚本把 Electron 的 userData 指到临时目录，
 *      这里的数据只写进那个临时库，脚本结束就随目录一起删掉。
 *   2. **不含任何真实密钥**。`apiKey` 固定为空串；不写 WebDAV 密码、
 *      不写任何 `sk-` 开头的字符串。
 *   3. **数据要能撑起界面**。空列表截出来是一片「暂无数据」，看不出软件在
 *      做什么；所以每本书都配够了章节、人物、势力、事件与伏笔。
 *
 * 时间戳在生成时现算，不写死历史日期——否则截图里的「最后修改」会显得像
 * 一个多年没更新的项目。
 */

const DAY = 24 * 60 * 60 * 1000

function makeFixtureData(now = Date.now()) {
  const book1 = 'shots-book-fogharbor'
  const book2 = 'shots-book-nightforge'

  const ch = (bookId, i, title, content, extra = {}) => ({
    id: `${bookId}-ch-${i}`,
    bookId,
    title,
    content,
    order: i,
    arcId: `${bookId}-arc-1`,
    summary: content.slice(0, 60),
    status: 'done',
    timelineStart: `第${i}天`,
    timelineEnd: `第${i}天`,
    updatedAt: now - (13 - i) * 60000,
    createdAt: now - (13 - i) * 3600000,
    ...extra
  })

  // ---- 第一本：雾港灯书（12 章，结构完整） ----
  const b1Chapters = [
    ch(book1, 1, '潮汐来信', `雾从海面漫上来的时候，林见夏正把最后一盏灯挂上塔顶。

信是三天前到的，信封上没有寄件人，只有一枚被潮水泡得发白的火漆印。她认得那个纹样——十二年前，父亲失踪的那个夜里，灯塔的门缝里也塞着同样的东西。

「别在潮水涨满时点灯。」

纸上只有这八个字。她把信翻过来，背面是一行更小的字：今夜子时，旧书铺。

楼下的铜铃响了一声。林见夏没有回头，她知道那个脚步声是谁的——沈砚走路时左脚的落地总比右脚轻半分，十二年了，一点都没变。

「你还在点灯。」沈砚站在楼梯口，肩上落着雾，「港务局的人今晚会来。」

「我知道。」她划亮火柴，「所以我才要现在点。」`, {
      planStatus: 'confirmed',
      planVersion: 3,
      targetWords: 2400,
      povCharacterId: `${book1}-char-lin`,
      coreConflict: '林见夏坚持点灯，港务局与潮汐会同时施压',
      mustEvents: '收到潮汐来信；沈砚归来；子时去旧书铺',
      endingHook: '灯塔的灯在潮水涨满时亮了，海上却出现第二盏灯',
      acceptance: '写出潮水与灯的对峙感；沈砚的回归不能是巧合'
    }),
    ch(book1, 2, '旧书铺的子时', `旧书铺在雾港最窄的一条巷子里，门面只有一扇半开的窗。

阿棠把最后一盏煤油灯吹灭时，林见夏刚好推门进来。老人没有抬头，只把一本没有书名的册子推到桌沿。

「你父亲当年也问过同一个问题。」阿棠说，「潮声律不是禁令，是记账。」

册子的第一页画着一座倒立的灯塔，塔尖插进海底。第二页被撕掉了，边缘留着深色的指印，像被海水泡过又被火烤干。

沈砚在门外等她。他手里多了一把伞，伞面上绣着潮汐会的标记。

「你现在加入他们还来得及。」林见夏说。

「我不是加入。」沈砚把伞递给她，「我是来还十二年前的债。」`, {
      planStatus: 'confirmed',
      targetWords: 2200,
      povCharacterId: `${book1}-char-lin`,
      coreConflict: '阿棠揭示潮声律的另一层含义，沈砚的立场不明',
      endingHook: '册子第二页被谁撕走了'
    }),
    ch(book1, 3, '潮水涨满时', `港务局的汽笛拉了三长声，那是封港的信号。

林见夏站在灯塔的旋梯上，听见潮水一层层压过来。灯已经点亮，光柱扫过海面时，她看见水底下有东西在移动——不是鱼，太大，太整齐，像一队沉默的船。

沈砚冲上塔顶，脸色比雾还白。

「第三盏。」他说，「海上有三盏灯。」

她数过。东边一盏、南边一盏、脚下这一盏。三盏灯的位置连成一个她在地图上见过的三角形，而三角形正中央，是十二年前沉没的那艘补给船。

「潮声律的第一条，」阿棠的声音从对讲机里传来，断断续续，「是不能让海面自己亮起来。丫头，你把什么带回来了？」`, {
      planStatus: 'confirmed',
      targetWords: 2600,
      coreConflict: '海上出现额外的灯，潮声律被触发',
      endingHook: '对讲机里传来阿棠以外的第二个声音'
    }),
    ch(book1, 4, '倒立的灯塔', `册子上的画不是比喻。

退潮之后，林见夏在灯塔正下方的礁石间找到了入口。石阶向下延伸，墙壁上嵌着和她手里一模一样的灯座，只是全都朝下。

沈砚走在前面，火把的光照出一整面刻字。字迹被盐蚀得厉害，只有最下面一行还清楚：

「凡使海面自亮者，须以己身为灯。」

他停住了。

「你父亲的名字在这里。」沈砚说，手指停在一个被凿掉一半的刻痕上，「后面还有半个字，像是『续』。」

林见夏蹲下去看了很久。她忽然明白那封信为什么用潮水泡过的纸——寄信的人想让她知道，这地方曾经被淹过，还会再被淹一次。`),
    ch(book1, 5, '灯下的人', `港务局的船在黎明前靠了岸。

领队姓顾，顾寒舟，袖口别着一枚没有花纹的银扣。他不像来查灯的，更像来确认某样东西还在不在。

「林小姐，」他把一份文件放在桌上，「十二年前，你父亲签过一份协议。灯归港务局，人归潮汐会。」

「我爸不签这种东西。」

「他签了。」顾寒舟推过来一支笔，「现在轮到你了。」

林见夏没有接。她看见文件背面有一道极细的水痕，从页角一直延伸到签名栏，像是有人在潮水里举着它走过。

「这份协议被水泡过。」她说。

顾寒舟的手停在半空。那一瞬间，她确定他知道更多。`),
    ch(book1, 6, '第二封信', `信是夹在灯塔的补给箱里送来的，还是那个发白的火漆印。

这次只有一行字：「顾寒舟不是港务局的人。」

林见夏把信烧了。灰烬落进灯油里，她盯着那点黑看了很久。

沈砚说得对，她一直在点灯。可她现在才知道，灯照亮的从来不只是海面，还有那些藏在雾里、不敢让自己被看清的人。

入夜前，她去了趟旧书铺。阿棠不在，门从里面反锁着。窗台上放着一只倒扣的茶杯，杯底压着册子的第二页。`, {
      planStatus: 'confirmed',
      targetWords: 2000,
      endingHook: '第二页上的字迹属于林见夏自己'
    }),
    ch(book1, 7, '盐与名字', `第二页上写着一个名字，笔迹是她的。

林见夏确定自己从没写过。可那撇捺的运笔方式，连收笔时习惯性的一点都一模一样。

她把纸对着灯看。墨迹下面还有一层更淡的痕迹，像有人先写了什么，又被擦掉。她试着用阿棠教过的法子——把纸浸进淡盐水——底下那行字慢慢浮出来：

「见夏，别念我的名字。」

是父亲的字。她手一抖，纸掉进盆里，浮起一层细白的盐。`),
    ch(book1, 8, '潮汐会', `潮汐会的总部在港口东侧的仓库区，门口挂着两盏永远不灭的灯。

沈砚带她进去时，走廊两侧站满了人，没有一个人说话。尽头是一间圆形的屋子，墙上嵌着十二盏灯，其中三盏已经熄灭。

「熄灭的灯，对应三个没能回来的人。」沈砚说。

「我爸是第几个？」

沈砚没有回答。他走到墙边，把第七盏灯的灯罩取下来，递给她。灯座上刻着一个日期——十二年前，正是父亲失踪的那一夜。

「第七盏是你的。」他说，「从你第一次点亮灯塔开始，它就在这儿了。」`),
    ch(book1, 9, '不该亮的地方', `顾寒舟在退潮时找到了礁石入口。

他没有带枪，只带了一盏没有油的灯。

「你知道这下面是什么。」林见夏拦在石阶前。

「知道。」顾寒舟把空灯放在地上，「所以我才要下去。你父亲当年没下去，所以他回来了；我下去了，所以我姓顾。」

她没听懂后半句。沈砚却忽然上前一步，抓住了顾寒舟的手腕。

「你姓什么都好，」沈砚的声音很低，「别用她的灯。」

石阶深处传来水声，很慢，像有谁在数着什么。`),
    ch(book1, 10, '灯芯', `灯芯是用海草编的，这是雾港所有灯塔的规矩。

阿棠说过，海草吸水，火才稳。可林见夏在仓库找到的那一捆旧灯芯里，混着几缕极细的黑发。

她把黑发挑出来对着光看，颜色和她自己的头发一样。

楼下的铜铃又响了。这次她没有等脚步声，直接推开窗。雾里站着一个穿旧雨衣的人，看不清脸，手里提着一盏亮着的灯。

「见夏，」那人说，「把灯灭了。」`, {
      planStatus: 'confirmed',
      targetWords: 2400,
      endingHook: '来人的声音既像父亲，又像她自己'
    }),
    ch(book1, 11, '十二年前的那一夜', `雾散了。

这是雾港十二年来第一个没有雾的夜晚，所有人都走到街上抬头看。灯塔的光笔直地射向海面，没有一丝散射。

林见夏站在塔顶，终于看清了海上的东西。

那不是船，是一整片沉在水下的屋顶。屋脊挨着屋脊，窗户朝上，像一座被翻过来的城。城中央的广场上立着一座倒立的灯塔，和她脚下这座一模一样。

沈砚把伞收起来，任海风把头发吹乱。

「十二年前不是船沉了，」他说，「是城翻了。」

「那父亲——」

「他留下来把灯扶正了。」沈砚看着她，「现在轮到我们决定，扶正之后，这座城该不该浮上来。」`),
    ch(book1, 12, '灯还亮着', `天亮之前，林见夏做了三件事。

她先把父亲的协议烧了。纸在灯油里蜷起来，火苗窜得很高，像终于松了一口气。然后她把潮汐会总部那十二盏灯全部点亮，包括那三盏熄灭的。最后，她在旧书铺的窗台上留了一张字条。

阿棠第二天早上开门时，字条还在：

「灯我会一直点着。不是为了照亮海，是为了让你们知道，我在这儿。」

雾又漫了上来，比以往任何一天都淡。港务局的汽笛响起，顾寒舟站在码头上，抬头望向灯塔。

光扫过来的那一瞬，他没有躲。`, {
      planStatus: 'confirmed',
      targetWords: 2500,
      endingHook: '雾变淡了，但海上还有第二盏灯'
    })
  ]

  const b2Chapters = [
    ch(book2, 1, '炉火初生', `铁匠铺的火第一次点着时，周野才七岁。

师父说，铸剑的人要先学会听。听风箱、听铁坯、听火里那些细小的爆裂声。周野听了十年，终于在某个夜里听见铁在说话。

它说：还差一点。`),
    ch(book2, 2, '断锋', `那把剑断了。

断在剑脊第三寸，断口平整得像被什么极冷的东西切过。周野跪在炉前，把两截断锋捧了一整夜。

天亮时，他发现断口上结了一层薄霜，而炉火整夜未熄。`, {
      endingHook: '霜是从剑里长出来的'
    }),
    ch(book2, 3, '长夜', `师父走了，只留下一句话：「剑成之日，别让它见月亮。」

周野把七个字刻在风箱上。那之后的长夜里，他一次也没有抬头看过天。`)
  ]

  const collections = {
    [book1]: {
      volumes: [
        {
          id: `${book1}-vol-1`,
          title: '第一卷 · 雾与灯',
          order: 1,
          theme: '在封闭的港口里，坚持一件所有人都劝你放弃的事',
          goal: '点亮灯塔并查出父亲失踪的真相',
          conflict: '林见夏与港务局、潮汐会的三方拉扯',
          startState: '灯塔停用，港口的雾一年比一年重',
          stakes: '灯一旦熄灭，雾港将不再有船靠岸',
          turningPoint: '海上出现第二、第三盏灯',
          requiredBeats: '潮汐来信\n旧书铺的子时\n海上多出的灯',
          summary: '林见夏重新点亮灯塔，逐步逼近十二年前的真相。',
          status: 'writing'
        }
      ],
      arcs: [
        {
          id: `${book1}-arc-1`,
          title: '第一篇 · 来信',
          volumeId: `${book1}-vol-1`,
          order: 1,
          goal: '把读者带进雾港的规则与悬念',
          conflict: '点灯与禁灯的冲突',
          requiredBeats: '收到信\n子时赴约\n潮水涨满',
          summary: '从一封没有署名的信开始，灯塔与潮声律的秘密浮出水面。',
          status: 'writing'
        }
      ],
      scenes: [
        {
          id: `${book1}-scene-1`,
          title: '塔顶点灯',
          chapterId: `${book1}-ch-1`,
          order: 1,
          povCharacterId: `${book1}-char-lin`,
          locationId: `${book1}-loc-lighthouse`,
          characterIds: [`${book1}-char-lin`],
          purpose: '确立主角与灯塔的关系',
          conflict: '明知禁令仍要开灯',
          outcome: '灯塔重新亮起',
          summary: '雾漫上来时，林见夏点着了塔顶的灯。',
          status: 'done'
        },
        {
          id: `${book1}-scene-2`,
          title: '旧书铺的对话',
          chapterId: `${book1}-ch-2`,
          order: 1,
          povCharacterId: `${book1}-char-lin`,
          locationId: `${book1}-loc-bookshop`,
          characterIds: [`${book1}-char-lin`, `${book1}-char-tang`],
          purpose: '由阿棠交代潮声律的第二层含义',
          conflict: '老人只肯说一半',
          outcome: '得到一本无名的册子',
          summary: '阿棠把一本册子推到她面前，第二页被撕走了。',
          status: 'done'
        }
      ],
      characters: [
        {
          id: `${book1}-char-lin`,
          name: '林见夏',
          aliases: ['见夏', '守灯人'],
          identity: '雾港灯塔的年轻守灯人',
          currentPower: '无超凡能力',
          status: 'alive',
          currentLocationId: `${book1}-loc-lighthouse`,
          currentFactionId: `${book1}-fac-tide`,
          goals: '查清父亲十二年前失踪的真相，并守住灯塔',
          personality: '克制、固执，习惯把恐惧压到熄灯之后',
          relationships: '沈砚：旧识，十二年后归来；阿棠：父亲旧友；顾寒舟：立场不明的对手',
          secrets: '她能在潮水上涨时听见灯芯里的低语',
          background: '父亲是雾港上一任守灯人，十二年前失踪，官方说法是海难。',
          arc: '从「守住灯」到「明白灯为谁而亮」',
          lastUpdatedChapterId: `${book1}-ch-12`,
          sourceChapterId: `${book1}-ch-1`
        },
        {
          id: `${book1}-char-shen`,
          name: '沈砚',
          aliases: ['沈七'],
          identity: '潮汐会的记录员',
          currentPower: '熟悉潮汐会的仪轨',
          status: 'alive',
          currentLocationId: `${book1}-loc-bookshop`,
          currentFactionId: `${book1}-fac-tide`,
          goals: '偿还十二年前欠下的一笔债',
          personality: '话少，习惯用行动代替解释',
          relationships: '林见夏：旧识，也是他守了十二年的秘密的一部分',
          secrets: '十二年前是他把林见夏的父亲留在了礁石下面',
          lastUpdatedChapterId: `${book1}-ch-11`,
          sourceChapterId: `${book1}-ch-1`
        },
        {
          id: `${book1}-char-gu`,
          name: '顾寒舟',
          identity: '港务局特派调查员',
          status: 'alive',
          currentLocationId: `${book1}-loc-port`,
          currentFactionId: `${book1}-fac-harbor`,
          goals: '确认那份十二年前的协议是否仍然有效',
          personality: '礼貌、精确，从不把话说满',
          relationships: '林见夏：谈判对手，态度不明',
          secrets: '姓氏是假的，他知道礁石下面的东西',
          lastUpdatedChapterId: `${book1}-ch-9`,
          sourceChapterId: `${book1}-ch-5`
        },
        {
          id: `${book1}-char-tang`,
          name: '阿棠',
          aliases: ['棠伯'],
          identity: '旧书铺的老板',
          status: 'alive',
          currentLocationId: `${book1}-loc-bookshop`,
          goals: '把潮声律完整地交给下一个守灯人',
          personality: '慢，谨慎，对年轻人有一种近乎残酷的耐心',
          secrets: '册子的第二页是他撕下来的',
          lastUpdatedChapterId: `${book1}-ch-10`,
          sourceChapterId: `${book1}-ch-2`
        }
      ],
      locations: [
        {
          id: `${book1}-loc-lighthouse`,
          name: '雾港灯塔',
          description: '港口西侧礁石上的石塔，塔顶可俯瞰整片海湾。',
          currentState: '已重新点亮',
          rules: '潮水涨满时点灯，会照亮海面以下的东西。'
        },
        {
          id: `${book1}-loc-bookshop`,
          name: '旧书铺',
          description: '雾港最窄巷子里的一间铺面，只在子时前后开窗。',
          currentState: '窗台留着一张字条'
        },
        {
          id: `${book1}-loc-port`,
          name: '雾港码头',
          description: '常年雾气不散的货运码头，港务局的汽笛每天响三次。',
          currentState: '封港中'
        }
      ],
      factions: [
        {
          id: `${book1}-fac-tide`,
          name: '潮汐会',
          status: 'active',
          description: '管理雾港灯塔与潮声律的古老组织，总部设在东侧仓库区。',
          goals: '维持潮声律，不让海面自己亮起来',
          leaders: [`${book1}-char-tang`],
          allies: ['港务局'],
          enemies: []
        },
        {
          id: `${book1}-fac-harbor`,
          name: '港务局',
          status: 'active',
          description: '名义上管理港口事务，实际职责与潮声律密切相关。',
          goals: '执行十二年前签订的那份协议',
          leaders: [`${book1}-char-gu`],
          allies: [],
          enemies: ['潮汐会']
        }
      ],
      worldRules: [
        {
          id: `${book1}-rule-tide`,
          title: '潮声律',
          category: '核心律',
          rule: '潮水涨满时不得点灯；若海面自行亮起，守灯人须以己身为灯。',
          priority: 100,
          exceptions: '守灯人主动献灯时，可短暂豁免。',
          sourceChapterId: `${book1}-ch-2`
        },
        {
          id: `${book1}-rule-fog`,
          title: '雾的边界',
          category: '地理',
          rule: '雾只在港口湾内生成，越过灯塔连线即散。',
          priority: 60,
          sourceChapterId: `${book1}-ch-1`
        }
      ],
      events: [
        {
          id: `${book1}-ev-1`,
          title: '林见夏重新点亮灯塔',
          chapterId: `${book1}-ch-1`,
          time: '第1天 · 入夜',
          description: '在港务局封港前夕，林见夏不顾禁令点亮塔顶。',
          locationId: `${book1}-loc-lighthouse`,
          characterIds: [`${book1}-char-lin`],
          consequences: '灯塔恢复运转，也把她重新拖回十二年前的旧事。'
        },
        {
          id: `${book1}-ev-2`,
          title: '阿棠交出无名册子',
          chapterId: `${book1}-ch-2`,
          time: '第1天 · 子时',
          description: '阿棠把记录潮声律的册子交给林见夏，第二页已被撕走。',
          locationId: `${book1}-loc-bookshop`,
          characterIds: [`${book1}-char-lin`, `${book1}-char-tang`],
          consequences: '林见夏第一次知道潮声律不只是禁令。'
        },
        {
          id: `${book1}-ev-3`,
          title: '海面出现三盏灯',
          chapterId: `${book1}-ch-3`,
          time: '第2天 · 封港',
          description: '灯柱扫过海面时，林见夏发现海上还有另外两盏灯。',
          locationId: `${book1}-loc-lighthouse`,
          characterIds: [`${book1}-char-lin`, `${book1}-char-shen`],
          consequences: '潮声律被触发。'
        },
        {
          id: `${book1}-ev-4`,
          title: '沈砚说出十二年前的真相',
          chapterId: `${book1}-ch-11`,
          time: '第10天 · 雾散',
          description: '沈砚承认十二年前沉没的不是船，而是一座城。',
          characterIds: [`${book1}-char-lin`, `${book1}-char-shen`],
          consequences: '林见夏知道自己面对的不只是港务局。'
        },
        {
          id: `${book1}-ev-5`,
          title: '协议被烧毁',
          chapterId: `${book1}-ch-12`,
          time: '第11天 · 天亮前',
          description: '林见夏烧掉父亲签下的协议，并点亮潮汐会的十二盏灯。',
          characterIds: [`${book1}-char-lin`],
          consequences: '旧秩序被打破，她选择继续点灯。'
        }
      ],
      foreshadowing: [
        {
          id: `${book1}-fs-1`,
          title: '被撕走的第二页',
          content: '册子的第二页在阿棠手里被撕走，边缘留有水痕与指印。',
          status: 'developing',
          firstChapterId: `${book1}-ch-2`,
          expectedRevealChapterId: `${book1}-ch-7`,
          relatedCharacterIds: [`${book1}-char-tang`],
          revealMeaning: '第二页上写着林见夏自己的笔迹，说明她曾来过这里。'
        },
        {
          id: `${book1}-fs-2`,
          title: '灯芯里的黑发',
          content: '旧灯芯中混着与林见夏同色的黑发。',
          status: 'planted',
          firstChapterId: `${book1}-ch-10`,
          expectedRevealChapterId: `${book1}-ch-12`,
          relatedCharacterIds: [`${book1}-char-lin`]
        },
        {
          id: `${book1}-fs-3`,
          title: '顾寒舟的银扣',
          content: '顾寒舟袖口别着一枚没有花纹的银扣。',
          status: 'revealed',
          firstChapterId: `${book1}-ch-5`,
          expectedRevealChapterId: `${book1}-ch-9`,
          relatedCharacterIds: [`${book1}-char-gu`],
          revealMeaning: '银扣是潮汐会旧式记录员的标记，说明他并非港务局的人。'
        }
      ],
      styleProfiles: [
        {
          id: `${book1}-style-1`,
          title: '冷雾·短句',
          active: true,
          pov: 'third-limited',
          tense: 'past',
          sentenceRhythm: '短句为主，关键处用一个长句压住节奏；每段不超过五句。',
          dialogueRatio: '对白约四成，克制，不解释情绪。',
          vocabulary: '海、雾、灯、盐、潮；避免网络语与现代口语。',
          bannedExpressions: '不禁\n仿佛整个世界都\n嘴角勾起一抹',
          characterVoices: '林见夏：短句，少用形容词\n沈砚：答非所问，常以动作代替回答\n阿棠：慢，爱用旧词',
          sample: '雾从海面漫上来的时候，林见夏正把最后一盏灯挂上塔顶。'
        }
      ],
      generationRuns: [
        {
          id: `${book1}-run-1`,
          bookId: book1,
          chapterId: `${book1}-ch-12`,
          action: 'continue',
          stage: 'write',
          provider: 'deepseek',
          model: 'deepseek-chat',
          inputTokens: 4820,
          outputTokens: 1680,
          cost: 0.0093,
          currency: 'CNY',
          priced: true,
          usageSource: 'provider',
          durationMs: 42100,
          status: 'done',
          attempts: 1,
          promptVersion: 'v4.0',
          params: { temperature: 1, maxTokens: 4096 },
          contextSummary: {
            totalTokens: 4820,
            dropped: [],
            layers: ['writingRules', 'bookPlan', 'chapterPlan', 'characters', 'recentChapters']
          },
          inputText: '（示例）接着写林见夏在灯塔顶上的收束场景。',
          outputText: '（示例）天亮之前，林见夏做了三件事。',
          createdAt: now - 2 * 3600000,
          updatedAt: now - 2 * 3600000
        },
        {
          id: `${book1}-run-2`,
          bookId: book1,
          chapterId: `${book1}-ch-12`,
          action: 'continue',
          stage: 'extract',
          provider: 'deepseek',
          model: 'deepseek-chat',
          inputTokens: 2100,
          outputTokens: 420,
          cost: 0.0028,
          currency: 'CNY',
          priced: true,
          usageSource: 'provider',
          durationMs: 18400,
          status: 'done',
          attempts: 1,
          promptVersion: 'v4.0',
          inputText: '（示例）从刚生成的正文中提取人物与事件。',
          outputText: '（示例）{"characters":[...]}',
          createdAt: now - 1.8 * 3600000,
          updatedAt: now - 1.8 * 3600000
        }
      ]
    },
    [book2]: {
      volumes: [],
      arcs: [],
      scenes: [],
      characters: [
        {
          id: `${book2}-char-zhou`,
          name: '周野',
          identity: '铁匠铺的年轻学徒',
          status: 'alive',
          goals: '铸出一把会说话的剑',
          personality: '执拗，能一整夜盯着一块铁',
          lastUpdatedChapterId: `${book2}-ch-3`
        }
      ],
      locations: [],
      factions: [],
      worldRules: [],
      events: [],
      foreshadowing: [
        {
          id: `${book2}-fs-1`,
          title: '剑脊上的薄霜',
          content: '断剑的断口在天亮时结了一层霜，而炉火整夜未熄。',
          status: 'planted',
          firstChapterId: `${book2}-ch-2`,
          relatedCharacterIds: [`${book2}-char-zhou`]
        }
      ],
      styleProfiles: [],
      generationRuns: []
    }
  }

  const books = [
    {
      id: book1,
      title: '雾港灯书',
      intro: '一座终年不散的雾港，一盏不许在潮水涨满时点亮的灯塔。守灯人林见夏收到一封没有署名的信，从此被拖回十二年前的旧事。',
      coverColor: '#4a90d9',
      plan: {
        premise: '在一个以「灯」为秩序的小港，守灯人必须遵守一条看似无理的禁令。',
        theme: '坚持与代价：有些光不是为了照亮，而是为了让人知道你还在这里。',
        mainConflict: '林见夏想查清真相，而所有知道真相的人都在阻止她点灯。',
        coreMystery: '十二年前沉没的到底是什么？父亲留下了什么？',
        finalGoal: '在潮水涨满时守住灯塔，并决定海面下的城该不该浮上来。',
        hardRules: '潮水涨满时不得点灯\n雾只在湾内生成\n守灯人必须独身值守',
        endingConstraint: '灯必须继续亮着，但代价必须被明确付出。'
      },
      createdAt: now - 30 * DAY,
      updatedAt: now - 2 * 3600000,
      currentVolumeId: `${book1}-vol-1`,
      currentArcId: `${book1}-arc-1`,
      currentChapterId: `${book1}-ch-12`,
      currentPointerUpdatedAt: now - 2 * 3600000
    },
    {
      id: book2,
      title: '长夜铸剑',
      intro: '铸剑的人要先学会听。周野听了十年，终于在某个夜里听见铁在说话——它说，还差一点。',
      coverColor: '#5b7f8f',
      plan: {
        premise: '一把会说话的剑，和一个不肯让它见月亮的铁匠。',
        theme: '手艺、执念与放手。',
        mainConflict: '周野想铸成剑，而剑想借他成型。',
        coreMystery: '剑里到底封着什么？',
        finalGoal: '在月圆之前决定，是封炉还是开炉。',
        hardRules: '剑成之日，别让它见月亮。',
        endingConstraint: '必须明确选择封炉或开炉，不能含糊。'
      },
      createdAt: now - 20 * DAY,
      updatedAt: now - 6 * DAY,
      currentVolumeId: null,
      currentArcId: null,
      currentChapterId: `${book2}-ch-3`,
      currentPointerUpdatedAt: now - 6 * DAY
    }
  ]

  const outlines = [
    {
      id: `${book1}-outline-1`,
      bookId: book1,
      type: 'outline',
      title: '主线大纲',
      content: '第一卷：林见夏点灯，收到信，进入潮汐会，发现海面下的城。\n第二卷（未写）：城的浮起与代价。',
      updatedAt: now - 10 * DAY
    }
  ]

  // 章节标题里的「第N章」由界面自己拼，这里只放标题
  const chapters = { [book1]: b1Chapters, [book2]: b2Chapters }

  return { books, chapters, outlines, collections }
}

module.exports = { makeFixtureData }
