import { HttpException, IMCRequest, IMCResponse, IUser } from '@root/api/types'
import config from '@root/api/utils/configLoader'
import { Hooks, IColumnInfo, ITableInfo } from '@root/configGenerator'
import { ErrorRequestHandler, NextFunction } from 'express'
import Knex from 'knex'

export function catchMiddleware(next: NextFunction, err: HttpException) {
  if (next) {
    next(err)
  }
}

export function addToResponse(res: IMCResponse, target: string) {
  return function(data: any) {
    if (res) {
      res.data = {
        ...res.data,
        [target]: data,
      }
      return res
    }
    throw new HttpException(500, 'Response object not valid')
  }
}

export function nextAndReturn(next: NextFunction) {
  return function(data: any) {
    if (next) {
      next()
    }
    return Promise.resolve(data)
  }
}

// error handler
export const errorHandler: ErrorRequestHandler = (err, req, res) => {
  res.status(err.status || 500)
  res.json({
    message: err.message,
  })
}

export function hasAuthorization(
  tableRoles: string[],
  user: IUser = {
    roles: [
      {
        id: 0,
        name: 'unauthenticated',
      },
    ],
  }
): boolean {
  let isAuthorized: string | undefined = 'true'
  if (tableRoles && tableRoles.length) {
    isAuthorized = tableRoles.find(
      (tableRole: string) => {
        if (tableRole === 'all') {
          return true
        }
        const userHasAuthorization = user.roles.find(
          (userRole) => {
            return (userRole.name === tableRole);
          }
        )
        return userHasAuthorization ? true : false
      }
    )
  }

  return isAuthorized ? true : false
}

export function filterVisibleTableColumns(table: ITableInfo, target: 'main' | 'detail') {
  const toKeep: {
    [key: string]: boolean
  } = {}
  if (table.chips) {
    table.chips.forEach(
      (chip) => {
        chip.columns.forEach(
          (column) => {
            toKeep[column.name] = true
          }
        )
      }
    )
  }
  return table.columns.filter(
    (column) => column.visible[target] || column.name === table.pk || toKeep[column.name]
  ).map(
    (column) => column.name
  )
}

export function runHook(
  TABLE: ITableInfo,
  hook: Hooks,
  instance: 'after' | 'before',
  req: IMCRequest,
  res: IMCResponse,
  database: Knex | null,
  results?: any
) {
  if (TABLE.hooks && TABLE.hooks[hook]) {
    const HOOK = TABLE.hooks[hook]
    if (database && HOOK && HOOK[instance]) {
      const CALLER  = HOOK[instance]
      return CALLER ?
        instance === 'before' ?
          CALLER(req, res, database, TABLE.name, results)
          :
          CALLER(req, res, database, TABLE.name, results)
        :
        Promise.resolve(hook === 'getTableCount' ? results.length : results)
    }
  }
  return Promise.resolve(hook === 'getTableCount' ? results.length : results)
}

export function getTableConfig(TABLE_NAME: string) {
  return config().settings.filter(
    (tableItem) => tableItem.name === TABLE_NAME
  )[0]
}

export function getColumnsByName(TABLE_CONFIG: ITableInfo) {
  const columnsByName: {
    [key: string]: IColumnInfo
  } = {}

  TABLE_CONFIG.columns.forEach(
    (column) => {
      columnsByName[column.name] = column
    }
  )

  return columnsByName
}

export function getColumnsWithRelations(TABLE_CONFIG: ITableInfo) {
  return TABLE_CONFIG.columns.filter(
    (column) => column.relation
  )
}

export function applyQueryFilters(QUERY: Knex.QueryBuilder, filters: string, TABLE_CONFIG: ITableInfo) {
  const columnsByName = getColumnsByName(TABLE_CONFIG)
  const FILTERS = JSON.parse(filters)
  Object.keys(FILTERS).forEach(
    (key, index) => {
      if (columnsByName[key].type === 'int(11)') {
        index === 0 ?
          QUERY.where({
            [key]: FILTERS[key],
          }) :
          QUERY.andWhere({
            [key]: FILTERS[key],
          })
      } else {
        index === 0 ?
          QUERY.where(key, 'like', '%' + FILTERS[key] + '%') :
          QUERY.andWhere(key, 'like', '%' + FILTERS[key] + '%')
      }
    }
  )

  return QUERY
}

export function applyQuerySearch(QUERY: Knex.QueryBuilder, search: string, TABLE_CONFIG: ITableInfo) {
  const searchFields = TABLE_CONFIG.searchFields || []
  QUERY.where(function() {
    searchFields.forEach(
      (searchField, index) => {
        index === 0 ?
          this.where(searchField, 'like', '%' + search + '%') :
          this.orWhere(searchField, 'like', '%' + search + '%')
      }
    )
  })

  return QUERY
}
