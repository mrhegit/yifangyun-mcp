# yifangyun-mcp-server

亿方云云盘访问 MCP Server。它让支持 MCP 的智能体可以通过亿方云 OpenAPI 查询企业组织、部门云盘目录、文件详情和下载链接。服务默认采用亿方云企业 JWT 模式认证，支持公有云和第三方私有化部署。

## 核心特性

| 特性 | 说明 |
|---|---|
| 企业 JWT 默认认证 | 使用 `grant_type=jwt_simple` 换取企业 token 和用户 token |
| 私有化部署适配 | 支持 `https://host/openapi` 和 `https://host/openapi/api` 两类地址配置 |
| 部门云盘访问 | 支持部门树、部门成员、部门首层目录、文件夹子项 |
| 搜索能力 | 支持个人空间、协作空间、部门空间、指定文件夹范围搜索 |
| 下载链接 | 只返回亿方云预签名下载 URL，不下载文件内容 |
| 安全优先 | 第一版只读，不包含上传、删除、移动、协作权限修改等写操作 |
| 输出裁剪 | 默认返回适合智能体使用的关键字段，避免把完整 API 响应塞满上下文 |

## 第一版能力边界

第一版定位为“只读云盘访问 MCP”。它适合用于查询资料、定位部门目录、搜索文件、获取文件元信息和下载链接。

暂不实现以下写操作：上传文件、上传新版本、移动文件、重命名、删除、清空回收站、恢复回收站、协作权限管理。原因是这些能力会改变真实云盘状态，后续如果要开放，应单独增加危险操作开关和二次确认机制。

## 工具列表

| Tool | 能力 | Token |
|---|---|---|
| `yfy_auth_test` | 验证企业 JWT、用户 JWT、基础接口 | 企业 + 用户 |
| `yfy_get_user_info` | 获取用户基础信息 | 用户 |
| `yfy_get_department_info` | 获取部门详情 | 企业 |
| `yfy_list_department_children` | 获取子部门 | 企业 |
| `yfy_list_department_users` | 获取部门成员 | 企业 |
| `yfy_list_personal_items` | 获取个人空间首层文件和文件夹 | 用户 |
| `yfy_list_department_folders` | 获取部门首层文件夹 | 用户 |
| `yfy_list_folder_children` | 获取文件夹下一级文件和文件夹 | 用户 |
| `yfy_search_items` | 搜索文件或文件夹，支持部门和文件夹范围 | 用户 |
| `yfy_get_file_info` | 获取文件详情 | 用户 |
| `yfy_get_download_url` | 获取文件预签名下载链接，不下载文件内容 | 用户 |

## 快速开始

```bash
npm install
npm run build
```

配置环境变量。公有云地址默认指向 `https://open.fangcloud.com`，通常只需要配置凭证和企业/用户 ID：

```bash
YFY_CLIENT_ID=your-client-id
YFY_CLIENT_SECRET=your-client-secret
YFY_ENTERPRISE_ID=115
YFY_DEFAULT_USER_ID=530
```

私有化部署再显式覆盖地址：

```bash
YFY_OPENAPI_BASE_URL=https://qiyeyun.example.com/openapi
YFY_OAUTH_BASE_URL=https://qiyeyun.example.com/openoauth
```

启动 stdio MCP：

```bash
npm start
```

## MCP 客户端配置示例

```json
{
  "mcpServers": {
    "yifangyun": {
      "command": "node",
      "args": ["/path/to/yifangyun-mcp/dist/index.js"],
      "env": {
        "YFY_CLIENT_ID": "your-client-id",
        "YFY_CLIENT_SECRET": "your-client-secret",
        "YFY_ENTERPRISE_ID": "115",
        "YFY_DEFAULT_USER_ID": "530"
      }
    }
  }
}
```

## 权限模型

亿方云 OpenAPI 存在两个权限平面。

| 权限平面 | Token | 适用接口 |
|---|---|---|
| 企业管理 | 企业 token | 部门详情、子部门、部门成员 |
| 云盘访问 | 用户 token | 个人空间、部门目录、搜索、文件详情、下载链接 |

即使某个账号是云盘管理员，也不要假设企业 token 能直接访问文件接口。文件访问工具默认使用 `YFY_DEFAULT_USER_ID`。如果希望默认以管理员身份访问文件，可配置 `YFY_ADMIN_USER_ID` 和 `YFY_FILE_ACCESS_USER_STRATEGY=admin`。

## 典型调用链

查找某部门下的资料目录：

```text
yfy_list_department_children(department_id=0)
  -> 找到目标一级部门
yfy_list_department_children(department_id=<一级部门ID>)
  -> 找到目标子部门
yfy_list_department_folders(department_id=<子部门ID>)
  -> 找到部门云盘首层目录
yfy_list_folder_children(folder_id=<目录ID>)
  -> 查看目录下文件和文件夹
```

搜索部门文件：

```text
yfy_search_items(
  query_words="营业执照",
  type="file",
  query_filter="file_name",
  department_id="480"
)
```

获取文件下载链接：

```text
yfy_get_file_info(file_id=<文件ID>)
yfy_get_download_url(file_id=<文件ID>)
```

## 详细文档

| 文档 | 内容 |
|---|---|
| [配置说明](docs/configuration.md) | 环境变量、私有化部署地址、管理员策略 |
| [工具参考](docs/tools.md) | 11 个 MCP 工具的参数、返回、示例 |
| [部署指南](docs/deployment.md) | 本地运行、MCP 客户端接入、GitHub 安装建议 |
| [架构与安全](docs/architecture-security.md) | 认证流程、权限边界、安全设计、已知限制 |

## 开发命令

```bash
npm install
npm run build
npm run dev
```

## 版本状态

当前版本：`0.1.0`。

该版本已完成真实私有化部署接口验证：企业 token、用户 token、根部门、子部门、部门目录、文件夹子项、搜索、文件详情、下载链接均可用。
