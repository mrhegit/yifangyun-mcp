# 亿方云开放平台 API 文档（离线索引版）

- 官方新版 Redoc 页面：https://open.fangcloud.com/wiki/v3/
- 旧入口：https://open.fangcloud.com/doc/api
- 生成日期：2026-06-02

> 说明：这是在当前受限执行环境中生成的离线索引版。官方页面显示 `Download OpenAPI specification: Download`，但本环境不能直接联网抓取该按钮背后的原始 JSON/YAML。因此本文档保留公开页面可见目录、端点名称和完整下载/转换步骤；需要机器可调用 schema 时，请以官方 Download 按钮导出的文件为准。

## 快速生成官方三件套

```bash
# 1. 在浏览器打开官方 Redoc 页面，点击 Download 保存为 fangcloud-openapi.json
#    https://open.fangcloud.com/wiki/v3/

# 2. 生成离线 HTML
npm i -g @redocly/cli
redocly build-docs fangcloud-openapi.json -o fangcloud-api.html

# 3. 生成 Markdown
npm i -g widdershins
widdershins fangcloud-openapi.json -o fangcloud-api.md
```

## 离线目录索引

### 开放平台简介

- 平台架构
- 名词解释
- 新手入门

### MCP服务

- 获取API_KEY
- 云盘MCP-STDIO
- 云盘-MCP
- 知识库KBASE-MCP

### 获取token

- token类型介绍
- 构建请求参数
- 获取用户id
- 获取token的java示例代码
- 获取token的python示例代码

### 调用接口

- 请求通用参数
- API请求示例
- 接口调用限制
- 异常处理

### 协作管理

- post 邀请协作
- post 批量邀请协作
- post 删除协作
- get 获取协作信息
- post 批量移出协作
- post 更新协作

### 评论管理

- post 添加评论
- post 删除评论

### 部门管理

- get 获取子部门列表
- get 获取部门信息
- get 获取自己所在的部门
- get 获取部门成员列表

### 设备管理

- post 加入同步
- get 获取设备同步状态
- post 移除同步

### 文件管理 ★★★

- post 拷贝文件
- post 按路径拷贝文件
- post 创建空白文件，支持office类型
- post 删除文件,被删除的文件将进入回收站
- post 从回收站中彻底删除文件,或者清空回收站
- get 下载文件
- get 获取文件特定版本信息
- post 删除文件版本
- get 获取文件版本列表
- post 提升版本为当前版本
- get 获取回收站中的文件信息
- get 获取文件详细信息
- get 获取最近使用文件列表
- get 获取文件的评论列表
- get 获取文件的分享链接列表
- post 标记最近使用
- post 移动文件到目标文件夹
- post 上传文件新版本
- post 批量下载文件
- post 从回收站中取回文件
- post 更新文件信息
- post 按路径上传文件
- post 上传文件

### 文件夹管理 ★★★

- post 拷贝文件夹
- post 创建文件夹
- post 按路径创建文件夹
- post 从回收站中删除文件夹
- post 删除文件夹
- get 获取回收站中的文件夹信息
- get 获取文件夹下的单层文件和文件夹列表
- get 获取与我协作的文件夹列表
- get 获取部门首层文件夹列表
- get 获取文件夹详细信息
- get 获取个人首层文件夹与文件列表
- get 获取文件夹协作成员
- get 获取文件夹的分享链接列表
- post 移动文件夹
- post 从回收站中取回文件夹
- post 更新文件夹详细信息

### 常用文件管理

- post 添加常用
- post 删除常用
- get 获取常用列表

### 群组管理

- get 获取公司可见群组
- get 获取群组成员列表

### 文件和文件夹公共管理

- get 搜索文件

### 知识库管理 ★★★

- post 知识库添加用户
- post 知识库对话接口
- post 创建知识目录
- post 创建知识库
- post 删除知识目录
- post 知识库删除文件
- post 删除知识库
- post 知识库删除用户
- post 知识库下载文件
- post 查询知识库文件训练片段
- post 查询训练文件训练状态
- post 获取知识目录列表
- post 查询知识目录用户列表
- post 获取知识库列表
- post 获取知识库角色列表
- post 获取知识库用户列表
- post 知识库打包下载文件
- post 知识库发布文件
- post 获取知识库文件列表
- post 更新知识目录详情
- post 知识库更新用户
- post 知识库上传文件
- post 知识库召回

### 智能体管理 ★★★

- post 新增Ai文件
- post 数据集添加训练任务
- post 智能体对话接口
- post 创建数据集
- post 数据集匹配测试
- post 创建智能体
- post 删除数据集
- post 删除训练任务
- post 删除智能体
- post 编辑智能体详情
- post 获取Ai文件详情
- post 获取智能体地址
- post 查询智能体详情
- post 获取知识员工token
- post 知识库召回
- get 获取智能体列表
- get 获取智能体分类列表
- post 查询数据集列表
- post 查询数据集问答对列表
- post 查询数据集知识片段列表
- post 获取智能体广场分类列表
- post 查询训练任务详情列表

### 审阅管理

- get 结束一个审阅
- post 添加审阅
- post 编辑审阅
- get 获得审阅评论列表
- get 获取审阅信息

### 审阅评论管理

- post 添加审阅评论
- del 删除审阅评论

### 分享链接管理

- post 创建分享链接
- get 获得分享链接信息
- get 获得分享链接详情信息
- post 删除分享链接
- post 更新分享链接

### 文件标签管理

- post 常用标签列表添加标签
- get 获取常用标签列表
- get 根据标签名称过滤项目
- post 项目新增标签
- post 项目移除标签
- get 获取项目最近使用标签列表（最近十个）
- post 常用标签列表移出标签

### 回收站管理

- post 清空回收站
- post 恢复回收站
- get 获取回收站列表

### 用户管理

- get 获取用户授权code
- get 获取自己的信息
- get 获取用户直属部门
- get 获取用户信息
- get 用户空间使用情况
- get 获取用户头像
- get 企业用户搜索
- post 更新用户信息

### 企业级部门管理

- post 添加部门成员
- post 创建部门
- post 删除部门
- get 获取子部门列表
- get 获取子部门空间列表
- post 获取部门的文件管理员信息
- get 获取仅管理员可见的部门信息
- post 移除部门成员
- post 修改部门
- post 修改部门空间大小
- get 获取详细的部门成员列表

### 企业级群组管理

- post 添加群组成员
- post 创建群组
- post 删除群组
- get 获取公司可见群组
- get 获取仅管理员可见的部门信息
- post 移除群组成员
- post 修改群组
- get 获取群组成员列表

### 企业级日志管理

- post 获取日志操作类型信息
- post 获取日志信息
- post 获取日志信息列表
- post 分页获取日志信息

### 企业级第三方平台管理

- get 获取关联部门
- get 获取关联群组
- get 获取关联用户
- post 批量同步部门
- post 批量同步群组
- post 批量同步用户

### 企业级用户管理

- post 创建用户
- post 删除用户
- get 获取用户登录参数
- get 获取用户登录链接
- get 获取用户信息
- get 获取仅管理员可见的用户信息
- post 修改用户

## 已知认证与接入信息摘要

- 文档说明开放平台密钥需要联系亿方云工作人员。
- `access_token` 是访问亿方云服务端开放接口的凭证；公开文档示例中普通有效期为 6 小时。
- 文档中 token 获取示例包含企业级 token、用户级 token、JWT/JWT-simple 相关说明。
- MCP 服务部分显示云盘与知识库 MCP，并列出 `search_files`、`list_personal_items`、`list_folder_contents`、`get_file_info`、`create_folder`、`upload_file`、`download_file` 等工具名称。

## 重要限制

本 Markdown 文件不是官方完整 API 参数/响应 schema。它适合作为离线索引、查目录和后续抓取入口；生成 SDK、校验请求体或导入 Postman 时，请使用官方 Download 导出的 OpenAPI JSON/YAML。