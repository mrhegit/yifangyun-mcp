# 工具参考

本文档详细说明第一版暴露的 11 个 MCP 工具。所有工具均为只读工具，不会上传、移动、删除或修改亿方云中的数据。

## 返回格式

所有工具都返回统一结构：

```json
{
  "ok": true,
  "data": {}
}
```

错误时返回：

```json
{
  "ok": false,
  "error": {
    "message": "错误说明",
    "retryable": false,
    "status_code": 403
  }
}
```

服务会同时返回 MCP `structuredContent` 和文本 JSON，方便不同 MCP 客户端消费。

## 通用参数

### `user_id`

`user_id` 用于指定文件访问身份。文件、搜索、下载相关工具都支持该参数。

未传时按 `YFY_FILE_ACCESS_USER_STRATEGY` 决定默认用户。

### 分页参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `page_id` | `0` | 亿方云接口使用的页码，从 0 开始 |
| `page_capacity` | `50` | 请求页容量，会受 `YFY_MAX_PAGE_CAPACITY` 限制 |

分页返回通常包含：

```json
{
  "page_id": 0,
  "page_capacity": 50,
  "page_count": 3,
  "total_count": 120,
  "has_more": true,
  "next_page_id": 1
}
```

## `yfy_auth_test`

验证企业 token、用户 token、根部门接口和用户信息接口是否可用。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 否 | 要测试的用户 ID，默认使用 `YFY_DEFAULT_USER_ID` |

示例：

```json
{
  "user_id": 530
}
```

适用场景：部署后第一步验证配置是否正确。

## `yfy_get_user_info`

获取用户基础信息。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 否 | 用户 ID，默认使用配置策略 |

示例：

```json
{}
```

## `yfy_get_department_info`

获取部门详情。使用企业 token。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `department_id` | 否 | 部门 ID，默认 `0`，根部门是否可用取决于部署 |

示例：

```json
{
  "department_id": 0
}
```

## `yfy_list_department_children`

列出某部门下的子部门。使用企业 token。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `department_id` | 否 | 父部门 ID，默认 `0` |
| `permission_filter` | 否 | 是否启用权限过滤，取决于部署支持 |

示例：

```json
{
  "department_id": 478
}
```

典型用途：先从根部门定位业务部门，再继续查子部门。

## `yfy_list_department_users`

列出部门成员。使用企业 token。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `department_id` | 是 | 部门 ID |
| `page_id` | 否 | 页码，默认 `0` |
| `include_contact` | 否 | 是否返回邮箱、手机号等联系字段，默认不返回 |

示例：

```json
{
  "department_id": 480,
  "include_contact": false
}
```

## `yfy_list_personal_items`

列出用户个人空间首层文件和文件夹。使用用户 token。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 否 | 用户 ID |
| `page_id` | 否 | 页码 |
| `page_capacity` | 否 | 页容量 |

示例：

```json
{
  "page_id": 0,
  "page_capacity": 50
}
```

## `yfy_list_department_folders`

列出部门云盘首层文件夹。使用用户 token，因为文件访问权限依赖用户身份。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `department_id` | 是 | 部门 ID |
| `user_id` | 否 | 文件访问用户 ID |
| `page_id` | 否 | 页码 |
| `page_capacity` | 否 | 页容量 |

示例：

```json
{
  "department_id": 480,
  "page_id": 0,
  "page_capacity": 100
}
```

## `yfy_list_folder_children`

列出文件夹下一级文件和文件夹。不会递归。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `folder_id` | 是 | 文件夹 ID |
| `type` | 否 | `file`、`folder`、`all`，默认 `all` |
| `user_id` | 否 | 文件访问用户 ID |
| `page_id` | 否 | 页码 |
| `page_capacity` | 否 | 页容量 |

示例：

```json
{
  "folder_id": 501000715605,
  "type": "all",
  "page_capacity": 100
}
```

## `yfy_search_items`

搜索文件或文件夹。支持全局、个人空间、协作空间、部门空间和指定文件夹范围。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `query_words` | 是 | 搜索关键词 |
| `type` | 否 | `file`、`folder`、`all` |
| `query_filter` | 否 | `file_name`、`content`、`creator`、`tag`、`all` |
| `department_id` | 否 | `0` 个人空间，`-1` 与我协作，部门 ID 表示部门空间 |
| `search_in_folder` | 否 | 限定父文件夹 ID |
| `sort_by` | 否 | `name`、`date`、`size`、`score` |
| `sort_direction` | 否 | `asc`、`desc` |
| `precise_search` | 否 | 是否精确搜索 |
| `fields` | 否 | 透传亿方云字段参数 |
| `user_id` | 否 | 文件访问用户 ID |
| `page_id` | 否 | 页码 |
| `page_capacity` | 否 | 页容量 |

部门内按文件名搜索：

```json
{
  "query_words": "营业执照",
  "type": "file",
  "query_filter": "file_name",
  "department_id": "480",
  "page_id": 0
}
```

指定文件夹内搜索：

```json
{
  "query_words": "合同",
  "type": "file",
  "query_filter": "file_name",
  "search_in_folder": 501000835604
}
```

## `yfy_get_file_info`

获取文件详情。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `file_id` | 是 | 文件 ID |
| `external_enterprise_id` | 否 | 外协企业 ID，外协文件需要时传入 |
| `user_id` | 否 | 文件访问用户 ID |

示例：

```json
{
  "file_id": 501001202974
}
```

## `yfy_get_download_url`

获取文件预签名下载链接。服务不会下载文件内容。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `file_id` | 是 | 文件 ID |
| `version` | 否 | 文件版本，未传时使用当前版本 |
| `external_enterprise_id` | 否 | 外协企业 ID |
| `user_id` | 否 | 文件访问用户 ID |

示例：

```json
{
  "file_id": 501001202974
}
```

安全提示：下载 URL 是临时访问凭证，不应写入日志或公开分享。

## 推荐工作流

查询某部门资料库：

```text
1. yfy_list_department_children(department_id=0)
2. yfy_list_department_children(department_id=<一级部门ID>)
3. yfy_list_department_folders(department_id=<目标部门ID>)
4. yfy_list_folder_children(folder_id=<资料库目录ID>)
```

搜索并下载文件：

```text
1. yfy_search_items(query_words="关键词", department_id="部门ID")
2. yfy_get_file_info(file_id=<文件ID>)
3. yfy_get_download_url(file_id=<文件ID>)
```
