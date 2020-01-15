import database, { Database } from '@root/api/db'
import { HttpException, IMCRequest, IMCResponse, IUser } from '@root/api/types'
import config from '@root/api/utils/configLoader'
import { Hooks, IColumnInfo, ITableInfo } from '@root/generator/configurationTypes'
import { ErrorRequestHandler, NextFunction } from 'express'
import Knex from 'knex'

export function catchMiddleware(next: NextFunction, err: HttpException) {
  if (next) {
    return next(err)
  }
  throw err
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
  if (process.env.NODE_ENV !== 'developement' && process.env.NODE_ENV !== 'test') {
    res.send('Error')
  } else {
    res.json({
      message: err.message,
    })
  }
}

/**
 * checks for user authorization against a list of roles
 * of the list has the role "all" return always true
 * @param {string[]} roles - a list of roles
 * @param {IUser} user - the express session user
 *
 * @returns {boolean} true if authorized, false if not
 */
export function hasAuthorization(
  roles: string[],
  user: IUser = {
    roles: [
      {
        id: 0,
        name: 'unauthenticated',
      },
    ],
  }
): boolean {
  let isAuthorized: boolean = true
  if (roles && roles.length) {
    isAuthorized = !!roles.find(
      (role: string) => {
        if (role === 'all') {
          return true
        }
        return !!user.roles.find(
          (userRole) => {
            return (userRole.name === role);
          }
        )
      }
    )
  }

  return isAuthorized
}

/**
 * given a table, filters the visible columns for the main or detail backoffice pages
 * @param {ITableInfo} table - a table configuration
 * @param {'main' | 'detail'} target - backoffice page
 *
 * @returns {IColumnInfo[]} array of filtered columns
 */
export function filterVisibleTableColumns(table: ITableInfo, target: 'main' | 'detail') {
  const toKeep: {
    [key: string]: boolean
  } = {}

  /**
   * since the chips are treated has columns by the frontend and they include data from multiple columns
   * we need to include all the related database columns in order to get all the necessary row data
   */
  if (table.chips && target === 'main') {
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
    (column) => column.visible[target] || table.pk.indexOf(column.name) >= 0  || toKeep[column.name]
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
  databaseTnstance: Knex | null,
  results?: any
) {
  if (TABLE.hooks && TABLE.hooks[hook]) {
    const HOOK = TABLE.hooks[hook]
    if (databaseTnstance && HOOK && HOOK[instance]) {
      const CALLER  = HOOK[instance]
      return CALLER ?
        instance === 'before' ?
          CALLER(req, res, databaseTnstance, TABLE.name, results)
          :
          CALLER(req, res, databaseTnstance, TABLE.name, results)
        :
        Promise.resolve(hook === 'getTableCount' ? results.length : results)
    }
  }
  return Promise.resolve(hook === 'getTableCount' ? results.length : results)
}

/**
 * returns the table configuration based on the table name
 * @param {string} TABLE_NAME - the name of the table
 *
 * @returns {ITableInfo} table configuration
 */
export function getTableConfig(TABLE_NAME: string) {
  return config().settings.filter(
    (tableItem) => tableItem.name === TABLE_NAME
  )[0]
}

/**
 * returns the columns configuration list transformed into an key:value object
 * where key equals to the column name, and value equals to the column configuration
 * @param {ITableInfo} TABLE_CONFIG - the table configuration
 *
 * @returns {{ [key: string]: IColumnInfo }} {[columnName]:[columnConfig]} object
 */
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

/**
 * returns the columns configuration list for the columns containing a relation
 * @param {ITableInfo} TABLE_CONFIG - the table configuration
 *
 * @returns {IColumnInfo[]} array of relation columns
 */
export function getColumnsWithRelations(TABLE_CONFIG: ITableInfo) {
  return TABLE_CONFIG.columns.filter(
    (column) => column.relation
  )
}

/**
 * helper function that sets the filters and search query to a Knex query object
 * @param {Knex.QueryBuilder} DB_QUERY - Knex query object
 * @param {object} reqQuer - parsed req.query object from express
 * @param {ITableInfo} TABLE_CONFIG - table configuration
 *
 * @returns {Knex.QueryBuilder} updated Knex query object
 */
export function applyQueryFiltersSearch(
  DB_QUERY: Knex.QueryBuilder,
  reqQuery: {[key: string]: any},
  TABLE_CONFIG: ITableInfo
) {
  if (reqQuery.filter) {
    DB_QUERY = applyQueryFilters(DB_QUERY, reqQuery.filter, TABLE_CONFIG)
  }
  if (reqQuery.search) {
    DB_QUERY = applyQuerySearch(DB_QUERY, reqQuery.search, TABLE_CONFIG)
  }
  return DB_QUERY
}

const oneToManyRelation = (table: ITableInfo, parentTable: ITableInfo) => table.relations &&
  table.relations.manyToOne && table.relations.manyToOne[parentTable.name] &&
  table.relations.manyToOne[parentTable.name][0]

const manyToOneRelation = (table: ITableInfo, parentTable: ITableInfo) => parentTable.relations &&
  parentTable.relations.manyToOne && parentTable.relations.manyToOne[table.name] &&
  parentTable.relations.manyToOne[table.name][0]

const manyToManyRelation = (table: ITableInfo, parentTable: ITableInfo) => parentTable.relations &&
  parentTable.relations.manyToMany && table.relations && table.relations.manyToMany && [
    table.relations.manyToMany && table.relations.manyToMany.find((r) => r.remoteTable === parentTable.name),
    parentTable.relations.manyToMany && parentTable.relations.manyToMany.find((r) => r.remoteTable === table.name),
  ]

export function applyParentTableFilters(
  QUERY: Knex.QueryBuilder,
  table: ITableInfo,
  parentTable: ITableInfo,
  parentObj: any
) {

  let relation: any = oneToManyRelation(table, parentTable)
  if (relation) {
    const column = parentTable.columns.find((col) => {
      return col.relation && col.relation.table ? true : false
    })
    if (column) {
      const key = relation.target
      const value = parentObj[column.name]
      return Promise.resolve(
        applyQueryFilters(QUERY, { [key]: value }, table).first()
      )
    }
  }

  relation = manyToOneRelation(table, parentTable)
  if (relation) {
    const column = table.columns.find((col) => {
      return col.relation && col.relation.table ? true : false
    })
    if (column) {
      const key = column.name
      const value = parentObj[relation.target]
      return Promise.resolve(
        applyQueryFilters(QUERY, { [key]: value }, table)
      )
    }
  }

  relation = manyToManyRelation(table, parentTable)
  if (relation) {
    const [childRelation, parentRelation] = relation
    if (childRelation && parentRelation && parentObj) {
      return database && database.db && database.db(
        childRelation.relationTable
      ).select([
        childRelation.remoteForeignKey,
        parentRelation.remoteForeignKey,
      ]).where(
        childRelation.remoteForeignKey,
        parentObj[childRelation.localId]
      ).then((results) => {
        const IDS = results.map((obj) => {
          return obj[parentRelation.remoteForeignKey]
        })
        const filter = {
          [parentRelation.remoteId]: IDS,
        }
        return applyQueryFilters(QUERY, filter, table)
      })
    }
  }
}

export function applyQueryFilters(
  QUERY: Knex.QueryBuilder,
  filters: string | {[key: string]: any},
  TABLE_CONFIG: ITableInfo
) {
  const columnsByName = getColumnsByName(TABLE_CONFIG)
  const FILTERS = typeof filters === 'string' ? JSON.parse(filters) : filters
  Object.keys(FILTERS).forEach(
    (key, index) => {
      if (
        columnsByName[key].type === 'int(11)'
        || columnsByName[key].type === 'smallint(5)'
        || columnsByName[key].type === 'datetime'
      ) {
        index === 0 ?
          (
            FILTERS[key] === null
              ? QUERY.whereNull(key)
              : Array.isArray(FILTERS[key])
                ? QUERY.whereIn(key, FILTERS[key])
                : QUERY.where({
                  [key]: FILTERS[key],
                })
          ) :
          (
            FILTERS[key] === null
              ? QUERY.andWhere((innerQuery) => {
                  innerQuery.whereNull(key)
                })
              : Array.isArray(FILTERS[key])
                ? QUERY.whereIn(key, FILTERS[key])
                : QUERY.andWhere({
                    [key]: FILTERS[key],
                  })
          )
      } else {
        index === 0 ?
          (
            FILTERS[key] === null
              ? QUERY.whereNull(key)
              : Array.isArray(FILTERS[key])
                ? QUERY.whereIn(key, FILTERS[key])
                : QUERY.where(key, 'like', '%' + FILTERS[key] + '%')
          ) :
          (
            FILTERS[key] === null
              ? QUERY.andWhere((innerQuery) => {
                  innerQuery.whereNull(key)
                })
              : Array.isArray(FILTERS[key])
                ? QUERY.whereIn(key, FILTERS[key])
                : QUERY.andWhere(key, 'like', '%' + FILTERS[key] + '%')
          )
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

interface IBodyWithPK {
  pk: {
    [key: string]: string | number
  }
}

/**
 * adds the necessary filters to filter a query by primary key
 * @param {Knex.QueryBuilder} QUERY - the Knex query builder
 * @param {IBodyWithPK} body - the express req.body object containing the primary keys object
 * @param {ITableInfo} TABLE_CONFIG - table configuration object
 *
 * @returns {Knex.QueryBuilder} the update Knex query builder with the filters set
 */
export function applyPKFilters(QUERY: Knex.QueryBuilder, body: IBodyWithPK, TABLE_CONFIG: ITableInfo) {
  const PKS = Object.keys(body.pk)

  if (typeof TABLE_CONFIG.pk === 'string' && PKS.length !== 1) {
    throw new HttpException(412, 'Incorrect set of primary keys')
  }

  if (Array.isArray(TABLE_CONFIG.pk) && TABLE_CONFIG.pk.length !== PKS.length) {
    throw new HttpException(412, 'Incorrect set of primary keys')
  }

  const columnsByName = getColumnsByName(TABLE_CONFIG)

  /**
   * goes through each primary key sent on the request
   * if a sent key is missing from the table it interrupts the cycle and throws an error
   */
  for (let index = 0; index < PKS.length; index += 1) {
    let valid = false
    if (Array.isArray(TABLE_CONFIG.pk)) {
      if (TABLE_CONFIG.pk.indexOf(PKS[index]) !== -1) {
        valid = true
      }
    } else if (TABLE_CONFIG.pk === PKS[index]) {
      valid = true
    }

    if (!valid) {
      throw new HttpException(412, `Primary key ${PKS[index]} missing on table`)
    }

    if (columnsByName[PKS[index]].type === 'int(11)') {
      index === 0 ?
        QUERY.where({
          [PKS[index]]: body.pk[PKS[index]],
        }) :
        QUERY.andWhere({
          [PKS[index]]: body.pk[PKS[index]],
        })
    } else {
      index === 0 ?
        QUERY.where(PKS[index], 'like', '%' + body.pk[PKS[index]] + '%') :
        QUERY.andWhere(PKS[index], 'like', '%' + body.pk[PKS[index]] + '%')
    }
  }

  return QUERY
}

/**
 * helper function to check for undefined, null, and empty values
 * @param {any} val - a variable
 *
 * @returns {boolean} true or false if val is a nullable value
 */
export function isNull(val: any) {
  return val === '' || val === undefined || val === null
}

/**
 * checks for user authorization to the table based on the type of access requested
 * @param {ITableInfo} tableConfig - a table configuration
 * @param {'read' | 'write' | 'delete'} accessType - the type of access being requested
 * @param {IUser | undefined} user - the express session user of none for unauthenticated users
 * @param {Database} dbInstance - the database instance
 *
 * @returns {Promise<Knex>} the database connector
 */
export function requirementsCheck(
  tableConfig: ITableInfo,
  accessType: 'read' | 'write' | 'delete',
  user: IUser | undefined,
  dbInstance: Database
) {
  if (!hasAuthorization(tableConfig.roles[accessType], user)) {
    return Promise.reject(new HttpException(401, 'Not authorized'))
  }
  if (!dbInstance.db) {
    return Promise.reject(new HttpException(500, 'No database'))
  }
  return Promise.resolve(dbInstance.db)
}
